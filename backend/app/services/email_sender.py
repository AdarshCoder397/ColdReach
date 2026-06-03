import smtplib
import random
import base64
import os
import httpx
from datetime import datetime, timedelta
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from email.utils import formatdate, make_msgid
from typing import Optional
import logging
from sqlalchemy.orm import Session

from app.core.encryption import decrypt_password
from app.models import (
    Lead, EmailAccount, SequenceStep, EmailEvent,
    EmailEventType, ScheduledEmail, Conversation, Message, MessageDirection
)
from app.core.config import settings

logger = logging.getLogger(__name__)


def generate_xoauth2_string(username: str, access_token: str) -> str:
    auth_str = f"user={username}\x01auth=Bearer {access_token}\x01\x01"
    return base64.b64encode(auth_str.encode()).decode()


def get_fresh_oauth_token(db: Session, email_account: EmailAccount) -> str:
    """Check if token is expired, refresh it if needed, and return the access_token."""
    token_data = email_account.oauth_token or {}
    expires_at = token_data.get("expires_at")
    
    # Refresh if expired or expires within 5 minutes
    now = datetime.utcnow().timestamp()
    if expires_at and now < expires_at - 300:
        return token_data.get("access_token")
        
    refresh_token = token_data.get("refresh_token")
    if not refresh_token:
        raise ValueError(f"No refresh token available for account {email_account.email}")
        
    provider = email_account.provider
    if provider == "google":
        url = "https://oauth2.googleapis.com/token"
        payload = {
            "client_id": settings.GOOGLE_CLIENT_ID,
            "client_secret": settings.GOOGLE_CLIENT_SECRET,
            "refresh_token": refresh_token,
            "grant_type": "refresh_token"
        }
    elif provider == "microsoft":
        url = "https://login.microsoftonline.com/common/oauth2/v2.0/token"
        payload = {
            "client_id": settings.MICROSOFT_CLIENT_ID,
            "client_secret": settings.MICROSOFT_CLIENT_SECRET,
            "refresh_token": refresh_token,
            "grant_type": "refresh_token"
        }
    else:
        raise ValueError(f"Unsupported OAuth provider: {provider}")
        
    try:
        response = httpx.post(url, data=payload, timeout=10)
        response.raise_for_status()
        data = response.json()
        
        access_token = data.get("access_token")
        expires_in = data.get("expires_in", 3600)
        
        # Update token data
        token_data["access_token"] = access_token
        token_data["expires_at"] = int(datetime.utcnow().timestamp()) + expires_in
        if data.get("refresh_token"):
            token_data["refresh_token"] = data.get("refresh_token")
            
        email_account.oauth_token = token_data
        db.commit()
        
        return access_token
    except Exception as e:
        logger.error(f"Failed to refresh OAuth token for {email_account.email}: {e}")
        raise ValueError(f"Token refresh failed: {e}")


def resolve_spyntax(text: str) -> str:
    """Resolve spyntax like {Hello|Hi|Hey} randomly."""
    if not text:
        return text
    import re
    pattern = re.compile(r"\{([^{}]*?\|[^{}]*?)\}")
    while True:
        match = pattern.search(text)
        if not match:
            break
        options = match.group(1).split("|")
        chosen = random.choice(options)
        text = text.replace(match.group(0), chosen, 1)
    return text


def personalize_template(template: str, lead: Lead) -> str:
    """Replace {{first_name}}, {{company}} etc with lead data"""
    replacements = {
        "{{first_name}}": lead.first_name or "",
        "{{last_name}}": lead.last_name or "",
        "{{full_name}}": f"{lead.first_name or ''} {lead.last_name or ''}".strip(),
        "{{company}}": lead.company or "",
        "{{email}}": lead.email,
        "{{website}}": lead.website or "",
    }
    # Also handle custom fields
    if lead.custom_fields:
        for key, val in lead.custom_fields.items():
            replacements[f"{{{{{key}}}}}"] = str(val)

    for placeholder, value in replacements.items():
        template = template.replace(placeholder, value)
    
    # Resolve Spyntax after replacing merge tags
    template = resolve_spyntax(template)
    return template


def send_email_via_smtp(
    db: Session,
    lead: Lead,
    sequence_step: SequenceStep,
    email_account: EmailAccount,
    thread_message_id: Optional[str] = None,  # For reply threading
) -> bool:
    """
    Send a single email. Returns True on success.
    Logs the event to email_events and creates/updates conversation.
    """
    import os
    from email.mime.application import MIMEApplication

    try:
        password = decrypt_password(email_account.smtp_password_encrypted) if email_account.smtp_password_encrypted else ""

        subject = personalize_template(sequence_step.subject, lead)
        body = personalize_template(sequence_step.body, lead)

        # Create email event first to get its ID for open tracking
        event = EmailEvent(
            lead_id=lead.id,
            campaign_id=lead.campaign_id,
            email_account_id=email_account.id,
            sequence_step_id=sequence_step.id,
            event_type=EmailEventType.SENT,
        )
        db.add(event)
        db.flush() # Populate event.id

        # Insert open tracking pixel if enabled and HTML email
        campaign = lead.campaign
        if campaign and campaign.track_open_rate and not sequence_step.is_plain_text:
            pixel_url = f"http://localhost:8000/api/track/open/{event.id}"
            pixel_html = f'<img src="{pixel_url}" width="1" height="1" style="display:none !important;" alt="" />'
            body = body + "\n" + pixel_html

        # Check for sequence step attachments
        attachments = sequence_step.attachments if hasattr(sequence_step, "attachments") else []

        # Build MIME message
        if attachments:
            msg = MIMEMultipart("mixed")
            # Attach body
            if sequence_step.is_plain_text:
                msg.attach(MIMEText(body, "plain"))
            else:
                alt_part = MIMEMultipart("alternative")
                alt_part.attach(MIMEText(body, "html"))
                msg.attach(alt_part)
            
            # Attach files
            for att in attachments:
                if os.path.exists(att.file_path):
                    with open(att.file_path, "rb") as f:
                        part = MIMEApplication(f.read(), Name=att.filename)
                    part['Content-Disposition'] = f'attachment; filename="{att.filename}"'
                    msg.attach(part)
                else:
                    logger.error(f"Attachment file not found at: {att.file_path}")
        else:
            if sequence_step.is_plain_text:
                msg = MIMEText(body, "plain")
            else:
                msg = MIMEMultipart("alternative")
                msg.attach(MIMEText(body, "html"))

        msg["From"] = f"{email_account.name} <{email_account.email}>"
        msg["To"] = lead.email
        msg["Subject"] = subject
        msg["Date"] = formatdate(localtime=True)

        message_id = make_msgid(domain=email_account.email.split("@")[1])
        msg["Message-ID"] = message_id
        event.message_id = message_id

        # Thread reply headers (for follow-ups)
        if thread_message_id:
            msg["In-Reply-To"] = thread_message_id
            msg["References"] = thread_message_id
            # Prefix subject for follow-ups if not already "Re:"
            if not subject.startswith("Re:"):
                msg["Subject"] = f"Re: {subject}"

        # Connect and send
        if email_account.use_tls:
            server = smtplib.SMTP(email_account.smtp_host, email_account.smtp_port)
            server.ehlo()
            server.starttls()
            server.ehlo()
        else:
            server = smtplib.SMTP_SSL(email_account.smtp_host, email_account.smtp_port)
            server.ehlo()

        if email_account.provider in ("google", "microsoft") and email_account.oauth_token:
            access_token = get_fresh_oauth_token(db, email_account)
            auth_string = generate_xoauth2_string(email_account.email, access_token)
            status_code, response = server.docmd("AUTH", f"XOAUTH2 {auth_string}")
            if status_code != 235:
                raise Exception(f"XOAUTH2 authentication failed: {status_code} {response.decode()}")
        else:
            server.login(email_account.smtp_username, password)

        server.sendmail(email_account.email, [lead.email], msg.as_string())
        server.quit()


        # Update/create conversation record
        _update_conversation(db, lead, subject, body, message_id)

        # Increment account daily counter
        email_account.emails_sent_today += 1
        email_account.last_reset_date = datetime.utcnow().strftime("%Y-%m-%d")
        db.commit()

        logger.info(f"Email sent to {lead.email} (step {sequence_step.step_number})")
        return True

    except Exception as e:
        logger.error(f"Failed to send email to {lead.email}: {e}")
        # Update the event to FAILED and commit
        event.event_type = EmailEventType.FAILED
        event.error_message = str(e)
        db.commit()
        return False


def _update_conversation(db: Session, lead: Lead, subject: str, body: str, message_id: str):
    """Create or update the master inbox conversation for this lead"""
    conv = db.query(Conversation).filter(Conversation.lead_id == lead.id).first()
    if not conv:
        conv = Conversation(
            lead_id=lead.id,
            campaign_id=lead.campaign_id,
        )
        db.add(conv)
        db.flush()

    msg = Message(
        conversation_id=conv.id,
        direction=MessageDirection.OUTBOUND,
        subject=subject,
        body=body,
        message_id=message_id,
        timestamp=datetime.utcnow(),
    )
    db.add(msg)
    conv.last_message_at = datetime.utcnow()


def calculate_send_time(
    campaign,
    base_date: Optional[datetime] = None,
    delay_days_min: int = 0,
    delay_days_max: int = 0,
) -> datetime:
    """
    Calculate when an email should be sent:
    1. Add random delay within [min_days, max_days]
    2. Pick a random time within the sending window
    3. Ensure it lands on an active day
    """
    base = base_date or datetime.utcnow()

    # Random delay
    delay = random.randint(delay_days_min, max(delay_days_min, delay_days_max))
    send_date = base + timedelta(days=delay)

    # Random time within sending window
    start_h, start_m = map(int, campaign.sending_window_start.split(":"))
    end_h, end_m = map(int, campaign.sending_window_end.split(":"))
    start_minutes = start_h * 60 + start_m
    end_minutes = end_h * 60 + end_m
    random_minutes = random.randint(start_minutes, end_minutes)
    send_time = send_date.replace(
        hour=random_minutes // 60,
        minute=random_minutes % 60,
        second=random.randint(0, 59),
        microsecond=0,
    )

    # Advance to next active day if needed
    day_names = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
    active_days = campaign.active_days or {}
    max_iterations = 14
    i = 0
    while i < max_iterations:
        day_name = day_names[send_time.weekday()]
        if active_days.get(day_name, True):
            break
        send_time += timedelta(days=1)
        i += 1

    return send_time


def send_reply_via_smtp(db: Session, conversation_id: int, body: str) -> bool:
    """Send a reply to a conversation via SMTP/XOAUTH2 and log it."""
    conv = db.query(Conversation).get(conversation_id)
    if not conv:
        raise ValueError("Conversation not found")

    lead = db.query(Lead).get(conv.lead_id)
    if not lead:
        raise ValueError("Lead not found")

    # Find the email account used for outreach
    last_event = db.query(EmailEvent).filter(
        EmailEvent.lead_id == lead.id,
        EmailEvent.email_account_id != None
    ).order_by(EmailEvent.timestamp.desc()).first()

    acct_id = last_event.email_account_id if last_event else None
    if not acct_id:
        cea = db.query(CampaignEmailAccount).filter(
            CampaignEmailAccount.campaign_id == lead.campaign_id,
            CampaignEmailAccount.is_active == True
        ).first()
        if cea:
            acct_id = cea.email_account_id

    if not acct_id:
        raise ValueError("No active email account connected to this campaign")

    account = db.query(EmailAccount).get(acct_id)
    if not account:
        raise ValueError("Connected email account not found")

    # Determine subject and thread ID
    last_msg = db.query(Message).filter(
        Message.conversation_id == conversation_id
    ).order_by(Message.timestamp.desc()).first()

    subject = last_msg.subject if last_msg and last_msg.subject else "Outreach Follow-up"
    if not subject.lower().startswith("re:"):
        subject = f"Re: {subject}"

    thread_msg_id = last_msg.message_id if last_msg else None

    # Build MIME Message
    msg = MIMEText(body, "plain")
    msg["From"] = f"{account.name} <{account.email}>"
    msg["To"] = lead.email
    msg["Subject"] = subject
    msg["Date"] = formatdate(localtime=True)

    message_id = make_msgid(domain=account.email.split("@")[1])
    msg["Message-ID"] = message_id

    if thread_msg_id:
        msg["In-Reply-To"] = thread_msg_id
        msg["References"] = thread_msg_id

    # Connect and send
    password = decrypt_password(account.smtp_password_encrypted) if account.smtp_password_encrypted else ""

    if account.use_tls:
        server = smtplib.SMTP(account.smtp_host, account.smtp_port)
        server.ehlo()
        server.starttls()
        server.ehlo()
    else:
        server = smtplib.SMTP_SSL(account.smtp_host, account.smtp_port)
        server.ehlo()

    if account.provider in ("google", "microsoft") and account.oauth_token:
        access_token = get_fresh_oauth_token(db, account)
        auth_string = generate_xoauth2_string(account.email, access_token)
        status_code, response = server.docmd("AUTH", f"XOAUTH2 {auth_string}")
        if status_code != 235:
            raise Exception(f"XOAUTH2 authentication failed: {status_code} {response.decode()}")
    else:
        server.login(account.smtp_username, password)

    server.sendmail(account.email, [lead.email], msg.as_string())
    server.quit()

    # Log to conversation
    new_msg = Message(
        conversation_id=conversation_id,
        direction=MessageDirection.OUTBOUND,
        subject=subject,
        body=body,
        message_id=message_id,
        timestamp=datetime.utcnow()
    )
    db.add(new_msg)
    conv.last_message_at = datetime.utcnow()
    conv.has_unread = False

    # Log as EmailEvent
    event = EmailEvent(
        lead_id=lead.id,
        campaign_id=lead.campaign_id,
        email_account_id=account.id,
        event_type=EmailEventType.SENT,
        message_id=message_id,
        timestamp=datetime.utcnow()
    )
    db.add(event)

    # Increment limit counter
    account.emails_sent_today += 1
    account.last_reset_date = datetime.utcnow().strftime("%Y-%m-%d")

    db.commit()
    return True
