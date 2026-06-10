"""
Reply detection via IMAP.
Runs every 5 minutes. Checks all connected inboxes for replies from campaign leads.

When a reply is found:
  1. Auto-detect the reply intent (OOO, not interested, interested, meeting booked etc.)
  2. Set lead status accordingly
  3. Cancel pending follow-ups (except OOO — reschedule those)
  4. Store reply in master inbox
"""
import imaplib
import email
import logging
import re
import html
from html.parser import HTMLParser
from datetime import datetime, timedelta
from email.header import decode_header
from typing import Optional, Tuple
from sqlalchemy.orm import Session

from app.models import (
    Lead, LeadStatus, EmailAccount, Conversation,
    Message, MessageDirection, EmailEvent, EmailEventType
)
from app.services.campaign_engine import cancel_pending_emails_for_lead

logger = logging.getLogger(__name__)


# ── Intent detection keywords ─────────────────────────────────────────────────

OOO_PATTERNS = [
    r"out of (the )?office",
    r"on (vacation|leave|holiday|pto|parental leave)",
    r"away (from|until|till)",
    r"will (be )?back",
    r"auto.?reply",
    r"automatic (reply|response)",
    r"i('m| am) (currently )?away",
    r"currently unavailable",
    r"returning on",
    r"return(ing)? (on|from)",
]

NOT_INTERESTED_PATTERNS = [
    r"not interested",
    r"no thank(s| you)",
    r"(please )?remove me",
    r"unsubscribe",
    r"don'?t (contact|email|reach out)",
    r"stop (emailing|contacting|sending)",
    r"not (the right|a good) (fit|time|match)",
    r"not for (us|me)",
    r"we('re| are) (all set|good|happy|not looking)",
    r"(not|no longer) (in (the )?market|interested|looking)",
]

INTERESTED_PATTERNS = [
    r"(sounds|looks|seems) (good|great|interesting|promising)",
    r"(i'?m|we'?re) interested",
    r"tell me more",
    r"(can|could) (you|we) (schedule|set up|arrange|book)",
    r"(let'?s|let us) (talk|chat|connect|discuss|meet)",
    r"(i'?d|we'?d) (like|love|want) to (learn|know|hear|see)",
    r"(please )?send (me|us) (more|the|your)",
    r"(what'?s|what is) (the )?price",
    r"(how much|pricing|cost)",
    r"(i'?m|i am) (open|happy|glad) to",
    r"when (are you|is a good time)",
    r"(free|available) (for a )?call",
]

MEETING_PATTERNS = [
    r"(book|schedule|set up|arrange|confirm) (a |the )?(meeting|call|demo|session|time)",
    r"(meeting|call|demo) (is |has been )?(confirmed|booked|scheduled|set)",
    r"(i|we) (have |'ve )?(confirmed|booked|accepted)",
    r"calendly",
    r"(see|talk|speak) (you|to you) (then|soon|on)",
    r"looking forward to (our|the) (call|meeting|demo|chat)",
]

WRONG_PERSON_PATTERNS = [
    r"wrong (person|address|email|contact)",
    r"not (the right|my) (person|department|team)",
    r"you (have|'ve) (the )?wrong",
    r"(i|this) (don'?t|doesn'?t) (handle|manage|deal with|work on)",
    r"(please )?contact (.+) instead",
    r"(i'?m|i am) no longer (at|with|in)",
    r"(i|this email) (has been|is) (transferred|moved|forwarded)",
]


class HTMLTextExtractor(HTMLParser):
    def __init__(self):
        super().__init__()
        self.reset()
        self.convert_charrefs = True
        self.result = []

    def handle_starttag(self, tag, attrs):
        if tag in ('p', 'br', 'div', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li'):
            self.result.append('\n')

    def handle_endtag(self, tag):
        if tag in ('p', 'div', 'tr', 'li'):
            self.result.append('\n')

    def handle_data(self, data):
        self.result.append(data)

    def get_text(self) -> str:
        text = ''.join(self.result)
        text = html.unescape(text)
        lines = [line.strip() for line in text.splitlines()]
        cleaned_lines = []
        for line in lines:
            if line:
                cleaned_lines.append(line)
            elif cleaned_lines and cleaned_lines[-1] != "":
                cleaned_lines.append("")
        return '\n'.join(cleaned_lines).strip()


def clean_html(html_content: str) -> str:
    try:
        extractor = HTMLTextExtractor()
        extractor.feed(html_content)
        return extractor.get_text()
    except Exception:
        import re
        text = re.sub(r'<[^>]+>', ' ', html_content)
        return html.unescape(text).strip()


def strip_reply_thread(body: str) -> str:
    if not body:
        return ""
    
    lines = body.splitlines()
    clean_lines = []
    
    for i, line in enumerate(lines):
        stripped = line.strip()
        
        # Stop at quoted lines
        if stripped.startswith(">") or stripped.startswith("|"):
            break
            
        # Stop at common email thread headers
        if re.search(r"^\s*on\s+.*wrote\s*:", stripped, re.IGNORECASE):
            break
        if re.search(r"wrote\s*:", stripped, re.IGNORECASE):
            break
        if re.search(r"^\s*from\s*:", stripped, re.IGNORECASE):
            break
        if re.search(r"^\s*to\s*:", stripped, re.IGNORECASE):
            break
        if re.search(r"^\s*date\s*:", stripped, re.IGNORECASE):
            break
        if re.search(r"^\s*subject\s*:", stripped, re.IGNORECASE):
            break
        if re.search(r"^-+original message-+$", stripped, re.IGNORECASE):
            break
        if re.search(r"^____+$", stripped):
            break
        if re.search(r"^----+$", stripped):
            break
            
        # Check for wrapped "On ... wrote:" header
        if stripped.lower().startswith("on ") and i + 1 < len(lines) and "wrote:" in lines[i+1].lower():
            break
        if stripped.lower().startswith("on ") and i + 2 < len(lines) and not lines[i+1].strip() and "wrote:" in lines[i+2].lower():
            break
            
        # Check for signature separators or starts
        if clean_lines:
            sig_markers = ["--", "thanks", "regards", "best regards", "sincerely", "warmly", "thanks & regards", "thanks and regards"]
            if stripped.lower() in sig_markers or any(stripped.lower().startswith(m + ",") for m in sig_markers) or any(stripped.lower().startswith(m + " ") for m in sig_markers):
                break
                
        clean_lines.append(line)
        
    return "\n".join(clean_lines).strip()


def detect_reply_intent(subject: str, body: str) -> Tuple[str, float]:
    """
    Analyse reply text and return (intent, confidence).
    Intent: OOO | NOT_INTERESTED | INTERESTED | MEETING_BOOKED | WRONG_PERSON | REPLIED
    Confidence: 0.0–1.0
    """
    cleaned_body = strip_reply_thread(body)
    text = f"{subject} {cleaned_body}".lower()

    # Check patterns in priority order
    checks = [
        ("OUT_OF_OFFICE",  OOO_PATTERNS,           0.9),
        ("MEETING_BOOKED", MEETING_PATTERNS,        0.85),
        ("NOT_INTERESTED", NOT_INTERESTED_PATTERNS, 0.85),
        ("INTERESTED",     INTERESTED_PATTERNS,     0.75),
        ("WRONG_PERSON",   WRONG_PERSON_PATTERNS,   0.8),
    ]

    for intent, patterns, confidence in checks:
        for pattern in patterns:
            if re.search(pattern, text, re.IGNORECASE):
                logger.info(f"Detected intent '{intent}' via pattern: {pattern!r}")
                return intent, confidence

    return "REPLIED", 0.5


def _map_intent_to_status(intent: str) -> LeadStatus:
    mapping = {
        "OUT_OF_OFFICE":  LeadStatus.OUT_OF_OFFICE,
        "MEETING_BOOKED": LeadStatus.MEETING_BOOKED,
        "INTERESTED":     LeadStatus.INTERESTED,
        "WRONG_PERSON":   LeadStatus.WRONG_PERSON,
        "NOT_INTERESTED": LeadStatus.NOT_INTERESTED,
        "REPLIED":        LeadStatus.REPLIED,
    }
    return mapping.get(intent, LeadStatus.REPLIED)


# ── Main IMAP checker ─────────────────────────────────────────────────────────

def check_all_inboxes_for_replies(db: Session):
    """Check every active email account with IMAP configured."""
    accounts = db.query(EmailAccount).filter(
        EmailAccount.is_active == True,
        EmailAccount.imap_host != None,
    ).all()

    logger.info(f"Checking {len(accounts)} inboxes for replies")
    for account in accounts:
        try:
            _check_inbox(db, account)
        except Exception as e:
            logger.error(f"IMAP error for {account.email}: {e}")


def _check_inbox(db: Session, account: EmailAccount):
    from app.core.encryption import decrypt_password
    password = decrypt_password(account.smtp_password_encrypted)

    if account.imap_use_ssl:
        mail = imaplib.IMAP4_SSL(account.imap_host, account.imap_port)
    else:
        mail = imaplib.IMAP4(account.imap_host, account.imap_port)

    mail.login(account.smtp_username, password)
    mail.select("INBOX")

    since_date = (datetime.utcnow() - timedelta(hours=24)).strftime("%d-%b-%Y")
    _, message_numbers = mail.search(None, f'(SINCE "{since_date}" UNSEEN)')

    if not message_numbers[0]:
        mail.logout()
        return

    for num in message_numbers[0].split():
        try:
            _, msg_data = mail.fetch(num, "(RFC822)")
            raw_email = msg_data[0][1]
            email_message = email.message_from_bytes(raw_email)

            from_addr = _parse_email_address(email_message.get("From", ""))
            subject   = _decode_header_value(email_message.get("Subject", ""))
            body      = _extract_body(email_message)

            if not from_addr:
                continue

            # Is this sender a bounce/mailer-daemon?
            is_bounce = any(x in from_addr.lower() for x in ["mailer-daemon", "postmaster", "noreply", "no-reply"])

            lead = db.query(Lead).filter(Lead.email == from_addr).first()
            if not lead:
                continue

            # Skip reply detection if track_reply_rate is disabled
            if lead.campaign and not lead.campaign.track_reply_rate:
                continue

            # ── Detect intent ────────────────────────────────────────────────
            intent, confidence = detect_reply_intent(subject, body)
            new_status = _map_intent_to_status(intent)

            logger.info(
                f"Reply from {lead.email}: intent={intent} "
                f"confidence={confidence:.0%} → status={new_status}"
            )

            # ── Handle bounce separately ─────────────────────────────────────
            if is_bounce:
                lead.status = LeadStatus.BOUNCED
                lead.status_changed_at = datetime.utcnow()
                lead.status_changed_by = "auto"
                lead.status_note = "Bounce detected from mailer-daemon"
                account.bounces_this_week = (account.bounces_this_week or 0) + 1
                cancel_pending_emails_for_lead(db, lead.id, reason="bounced")
                _log_event(db, lead, account, EmailEventType.BOUNCED)
                _store_message_if_new(db, lead, subject, body, email_message.get("Message-ID"))
                db.commit()
                continue

            # ── Skip if already in a terminal qualified state ────────────────
            # Don't downgrade MEETING_BOOKED → INTERESTED, etc.
            terminal_states = {
                LeadStatus.DO_NOT_CONTACT,
                LeadStatus.MEETING_BOOKED,
                LeadStatus.NOT_INTERESTED,
                LeadStatus.BOUNCED,
                LeadStatus.UNSUBSCRIBED,
            }
            if lead.status in terminal_states:
                _store_message_if_new(db, lead, subject, body, email_message.get("Message-ID"))
                db.commit()
                continue

            # ── Update lead status ───────────────────────────────────────────
            old_status = lead.status
            lead.status           = new_status
            lead.replied_at       = datetime.utcnow()
            lead.status_changed_at = datetime.utcnow()
            lead.status_changed_by = "auto"
            lead.status_note      = f"Auto-detected: {intent} (confidence {confidence:.0%})"

            # ── Handle OOO: reschedule instead of cancel ─────────────────────
            if new_status == LeadStatus.OUT_OF_OFFICE:
                _reschedule_ooo(db, lead, body)
            else:
                cancel_pending_emails_for_lead(db, lead.id, reason=f"reply_{intent.lower()}")

            # ── Log event ────────────────────────────────────────────────────
            _log_event(db, lead, account, EmailEventType.REPLIED)

            # ── Store in inbox ───────────────────────────────────────────────
            _store_message_if_new(db, lead, subject, body, email_message.get("Message-ID"))

            logger.info(f"Lead {lead.email}: {old_status} → {new_status}")
            db.commit()

        except Exception as e:
            logger.error(f"Error processing email {num}: {e}", exc_info=True)

    mail.logout()


def _reschedule_ooo(db, lead: Lead, body: str):
    """
    For OOO replies: push all pending emails out by 7 days
    (or try to parse the return date from the body).
    """
    from app.models import ScheduledEmail

    return_days = _parse_return_days(body) or 7

    pending = db.query(ScheduledEmail).filter(
        ScheduledEmail.lead_id == lead.id,
        ScheduledEmail.is_sent == False,
        ScheduledEmail.is_cancelled == False,
    ).all()

    for se in pending:
        se.scheduled_for = se.scheduled_for + timedelta(days=return_days)

    logger.info(
        f"OOO: pushed {len(pending)} emails for lead {lead.email} "
        f"by {return_days} days"
    )


def _parse_return_days(body: str) -> Optional[int]:
    """Try to extract how many days until the person returns from OOO text."""
    # Look for "back on [date]" or "returning [date]"
    patterns = [
        r"back on (\w+ \d+)",
        r"return(?:ing)? (?:on )?(\w+ \d+)",
        r"(?:until|till) (\w+ \d+)",
    ]
    for pattern in patterns:
        match = re.search(pattern, body, re.IGNORECASE)
        if match:
            try:
                date_str = match.group(1)
                # Try to parse month + day (assume current year)
                from datetime import datetime
                parsed = datetime.strptime(
                    f"{date_str} {datetime.utcnow().year}", "%B %d %Y"
                )
                days = (parsed - datetime.utcnow()).days
                if 1 <= days <= 60:
                    return days
            except Exception:
                pass
    return None


# ── Helpers ───────────────────────────────────────────────────────────────────

def _log_event(db, lead, account, event_type):
    event = EmailEvent(
        lead_id=lead.id,
        campaign_id=lead.campaign_id,
        email_account_id=account.id,
        event_type=event_type,
        timestamp=datetime.utcnow(),
    )
    db.add(event)


def _store_message_if_new(db, lead, subject, body, message_id):
    if message_id:
        existing = db.query(Message).filter(Message.message_id == message_id).first()
        if existing:
            return

    conv = db.query(Conversation).filter(Conversation.lead_id == lead.id).first()
    if not conv:
        conv = Conversation(lead_id=lead.id, campaign_id=lead.campaign_id)
        db.add(conv)
        db.flush()

    msg = Message(
        conversation_id=conv.id,
        direction=MessageDirection.INBOUND,
        subject=subject,
        body=body,
        message_id=message_id,
        timestamp=datetime.utcnow(),
    )
    db.add(msg)
    conv.last_message_at = datetime.utcnow()
    conv.has_unread = True


def _parse_email_address(from_header: str) -> Optional[str]:
    match = re.search(r'<(.+?)>', from_header)
    if match:
        return match.group(1).lower().strip()
    match = re.match(r'^[\w.+-]+@[\w-]+\.[a-zA-Z]+$', from_header.strip())
    if match:
        return from_header.strip().lower()
    return None


def _decode_header_value(value: str) -> str:
    decoded_parts = decode_header(value)
    result = []
    for part, charset in decoded_parts:
        if isinstance(part, bytes):
            result.append(part.decode(charset or "utf-8", errors="replace"))
        else:
            result.append(part)
    return " ".join(result)


def _extract_body(email_message) -> str:
    body = ""
    if email_message.is_multipart():
        for part in email_message.walk():
            if part.get_content_type() == "text/plain":
                try:
                    body = part.get_payload(decode=True).decode("utf-8", errors="replace")
                    break
                except Exception:
                    pass
        if not body:
            for part in email_message.walk():
                if part.get_content_type() == "text/html":
                    try:
                        html_body = part.get_payload(decode=True).decode("utf-8", errors="replace")
                        body = clean_html(html_body)
                        break
                    except Exception:
                        pass
    else:
        content_type = email_message.get_content_type()
        try:
            raw_payload = email_message.get_payload(decode=True)
            if raw_payload:
                decoded = raw_payload.decode("utf-8", errors="replace")
                if content_type == "text/html":
                    body = clean_html(decoded)
                else:
                    body = decoded
            else:
                body = ""
        except Exception:
            body = str(email_message.get_payload())
            
        if body and ("<html" in body.lower() or "<div" in body.lower() or "<p" in body.lower()):
            body = clean_html(body)
            
    return body[:5000]