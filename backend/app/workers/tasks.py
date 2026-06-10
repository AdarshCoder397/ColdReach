"""
Celery workers for:
  - send_due_emails (every 1 minute): sends scheduled emails whose time has come
  - check_replies (every 5 minutes): IMAP polling for replies
  - daily_scheduler (every day at midnight): allocates new leads + follow-ups
"""
from celery import Celery
from celery.schedules import crontab
from datetime import datetime
import logging

from app.core.config import settings
from app.core.database import SessionLocal

logger = logging.getLogger(__name__)

celery_app = Celery(
    "coldreach",
    broker=settings.REDIS_URL,
    backend=settings.REDIS_URL,
)

celery_app.conf.update(
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    timezone="UTC",
    enable_utc=True,
    beat_schedule={
        # Send due emails every minute
        "send-due-emails": {
            "task": "app.workers.tasks.send_due_emails",
            "schedule": 60.0,
        },
        # Check for replies every 5 minutes
        "check-replies": {
            "task": "app.workers.tasks.check_replies",
            "schedule": 300.0,
        },
        # Process campaign changes every 5 minutes
        "process-campaign-changes": {
            "task": "app.workers.tasks.process_campaign_changes",
            "schedule": 300.0,
        },
        # Daily scheduler at midnight UTC
        "daily-scheduler": {
            "task": "app.workers.tasks.run_daily_scheduler",
            "schedule": crontab(hour=0, minute=0),
        },
        # Keep Render server active by pinging itself every 10 minutes
        "keep-alive": {
            "task": "app.workers.tasks.keep_alive",
            "schedule": 600.0,
        },
    },
)


@celery_app.task(name="app.workers.tasks.send_due_emails")
def send_due_emails():
    """
    Find all scheduled emails due now and send them.
    Respects: account daily limits, campaign active status.
    """
    from app.models import ScheduledEmail, Lead, LeadStatus, EmailAccount, SequenceStep, Campaign, CampaignStatus
    from app.services.email_sender import send_email_via_smtp

    db = SessionLocal()
    try:
        now = datetime.utcnow()
        due = db.query(ScheduledEmail).filter(
            ScheduledEmail.scheduled_for <= now,
            ScheduledEmail.is_sent == False,
            ScheduledEmail.is_cancelled == False,
        ).all()

        logger.info(f"Found {len(due)} emails due to send")
        sent_count = 0

        for se in due:
            # Skip if campaign is not active (paused, draft, completed)
            campaign = db.query(Campaign).get(se.campaign_id)
            if not campaign or campaign.status != CampaignStatus.ACTIVE:
                continue

            lead = db.query(Lead).get(se.lead_id)
            if not lead:
                continue

            # Skip if lead replied or has non-active status
            if lead.status not in (LeadStatus.NEW, LeadStatus.CONTACTED, LeadStatus.OUT_OF_OFFICE):
                se.is_cancelled = True
                se.cancel_reason = f"lead_status_{lead.status}"
                continue

            step = db.query(SequenceStep).get(se.sequence_step_id)
            if not step:
                continue

            account = db.query(EmailAccount).get(se.email_account_id)
            if not account or not account.is_active:
                continue

            # Check daily limit for this account
            # Check account health — refuse to send from paused accounts
            if account.health_status == "PAUSED":
                logger.warning(f"Account {account.email} is PAUSED (health), skipping")
                se.is_cancelled = True
                se.cancel_reason = "account_paused_health"
                continue

            # Check daily limit (respects warm-up and throttle)
            today = now.strftime("%Y-%m-%d")
            if account.last_reset_date == today and account.emails_sent_today >= account.daily_limit:
                logger.info(f"Account {account.email} hit daily limit ({account.daily_limit}), skipping")
                continue

            # Get thread message_id for reply threading
            thread_msg_id = _get_thread_message_id(db, lead)

            success = send_email_via_smtp(db, lead, step, account, thread_msg_id)

            if success:
                se.is_sent = True
                se.sent_at = now
                lead.status = LeadStatus.CONTACTED
                lead.contacted_at = now
                lead.current_step = step.step_number
                # Update health tracking counters
                account.last_sent_at = now
                account.sends_this_week = (account.sends_this_week or 0) + 1
                sent_count += 1
            else:
                # Track failures for health scoring
                account.failures_this_week = (account.failures_this_week or 0) + 1

        db.commit()
        logger.info(f"Sent {sent_count} emails")
        return {"sent": sent_count}

    finally:
        db.close()


@celery_app.task(name="app.workers.tasks.check_replies")
def check_replies():
    """Poll all IMAP inboxes for replies"""
    from app.services.reply_detector import check_all_inboxes_for_replies

    db = SessionLocal()
    try:
        check_all_inboxes_for_replies(db)
        return {"status": "completed"}
    finally:
        db.close()


@celery_app.task(name="app.workers.tasks.run_daily_scheduler")
def run_daily_scheduler():
    """Allocate today's send quota across all active campaigns"""
    from app.services.campaign_engine import run_daily_scheduler as _run

    db = SessionLocal()
    try:
        _run(db)
        return {"status": "completed"}
    finally:
        db.close()


def _get_thread_message_id(db, lead):
    """Get the Message-ID of the first email sent to a lead (for threading)"""
    from app.models import EmailEvent, EmailEventType
    first_event = db.query(EmailEvent).filter(
        EmailEvent.lead_id == lead.id,
        EmailEvent.event_type == EmailEventType.SENT,
    ).order_by(EmailEvent.timestamp.asc()).first()
    return first_event.message_id if first_event else None


@celery_app.task(name="app.workers.tasks.process_campaign_changes")
def process_campaign_changes():
    """Find and apply pending campaign settings change events"""
    from app.models import CampaignChangeEvent
    from app.services.campaign_engine import apply_campaign_change_event
    
    db = SessionLocal()
    try:
        pending = db.query(CampaignChangeEvent).filter(
            CampaignChangeEvent.applied_at == None
        ).order_by(CampaignChangeEvent.created_at.asc()).all()
        
        logger.info(f"Found {len(pending)} pending campaign settings change events to apply")
        for event in pending:
            try:
                apply_campaign_change_event(db, event.id)
            except Exception as e:
                logger.error(f"Error applying change event {event.id}: {e}", exc_info=True)
        return {"processed": len(pending)}
    finally:
        db.close()


@celery_app.task(name="app.workers.tasks.keep_alive")
def keep_alive():
    """
    Send a GET request to the app's health endpoint to keep it awake on Render/hosting platforms.
    """
    import httpx
    
    url = settings.KEEP_ALIVE_URL or settings.RENDER_EXTERNAL_URL
    if not url:
        logger.info("No KEEP_ALIVE_URL or RENDER_EXTERNAL_URL set. Skipping keep-alive ping.")
        return {"status": "skipped", "reason": "no_url"}
        
    # Standardize the protocol
    if not url.startswith("http://") and not url.startswith("https://"):
        url = "https://" + url
        
    # Ensure URL ends with a health check path
    if not any(url.endswith(x) for x in ("/health", "/health/", "/api/health")):
        url = url.rstrip("/") + "/health"
        
    try:
        logger.info(f"Sending keep-alive ping to {url}")
        response = httpx.get(url, timeout=10.0)
        logger.info(f"Keep-alive response status code: {response.status_code}")
        return {"status": "success", "status_code": response.status_code}
    except Exception as e:
        logger.error(f"Keep-alive ping failed: {e}")
        return {"status": "failed", "error": str(e)}


