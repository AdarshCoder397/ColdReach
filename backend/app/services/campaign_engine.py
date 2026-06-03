"""
Campaign Engine — smart sending scheduler.

Key behaviours:
  - Spaces emails evenly across the sending window per account
  - Enforces account health checks (bounce rate, failure rate)
  - Stops scheduling for unhealthy accounts automatically
  - Supports warm-up ramp for new accounts
  - Enforces one-campaign-per-account constraint
"""
import logging
import math
import random
from datetime import datetime, timedelta
from typing import List, Optional
from sqlalchemy.orm import Session

from app.models import (
    Campaign, CampaignStatus, Lead, LeadStatus,
    Sequence, SequenceStep, ScheduledEmail, EmailAccount,
    CampaignEmailAccount,
)

logger = logging.getLogger(__name__)

# ── Health thresholds ──────────────────────────────────────────────────────────
BOUNCE_RATE_THROTTLE = 0.05   # 5%  bounce rate → THROTTLED (50% of limit)
BOUNCE_RATE_PAUSE    = 0.10   # 10% bounce rate → PAUSED (stop completely)
FAILURE_RATE_THROTTLE = 0.10  # 10% failure rate → THROTTLED
FAILURE_RATE_PAUSE    = 0.20  # 20% failure rate → PAUSED

# Warm-up schedule: day number → max emails that day
WARMUP_SCHEDULE = {
    1: 5,  2: 8,  3: 12,  4: 18,  5: 25,
    6: 35, 7: 45, 8: 55,  9: 65, 10: 75,
}
WARMUP_DAYS = 10  # After this many days, exit warm-up


def run_daily_scheduler(db: Session):
    """
    Main daily job. For each active campaign:
    1. Reset daily counters for email accounts
    2. Evaluate account health
    3. Calculate smart send intervals
    4. Queue follow-up emails (higher priority)
    5. Queue new lead first-touch emails
    """
    active_campaigns = db.query(Campaign).filter(
        Campaign.status == CampaignStatus.ACTIVE
    ).all()

    logger.info(f"Running daily scheduler for {len(active_campaigns)} campaigns")

    for campaign in active_campaigns:
        try:
            _reset_daily_counters(db, campaign)
            _evaluate_account_health(db, campaign)
            _schedule_campaign_emails(db, campaign)
        except Exception as e:
            logger.error(f"Error scheduling campaign {campaign.id}: {e}", exc_info=True)

    db.commit()


# ── Daily counter reset ────────────────────────────────────────────────────────

def _reset_daily_counters(db: Session, campaign: Campaign):
    today = datetime.utcnow().strftime("%Y-%m-%d")
    for cea in campaign.email_accounts:
        if not cea.is_active:
            continue
        account = cea.email_account
        if account.last_reset_date != today:
            account.emails_sent_today = 0
            account.last_reset_date = today

        # Reset weekly counters on Monday
        week_start = (datetime.utcnow() - timedelta(days=datetime.utcnow().weekday())).strftime("%Y-%m-%d")
        if account.last_week_reset != week_start:
            account.bounces_this_week = 0
            account.failures_this_week = 0
            account.sends_this_week = 0
            account.last_week_reset = week_start

        # Advance warm-up day counter
        if account.is_warming_up and account.warmup_start_date:
            start = datetime.strptime(account.warmup_start_date, "%Y-%m-%d")
            days_elapsed = (datetime.utcnow() - start).days + 1
            account.warmup_day_number = days_elapsed
            if days_elapsed > WARMUP_DAYS:
                account.is_warming_up = False
                account.health_status = "HEALTHY"
                logger.info(f"Account {account.email} completed warm-up")


# ── Health evaluation ──────────────────────────────────────────────────────────

def _evaluate_account_health(db: Session, campaign: Campaign):
    for cea in campaign.email_accounts:
        if not cea.is_active:
            continue
        account = cea.email_account
        sends = max(account.sends_this_week, 1)

        bounce_rate = account.bounces_this_week / sends
        failure_rate = account.failures_this_week / sends

        prev_status = account.health_status

        if account.is_warming_up:
            account.health_status = "WARMING"
        elif bounce_rate >= BOUNCE_RATE_PAUSE or failure_rate >= FAILURE_RATE_PAUSE:
            account.health_status = "PAUSED"
        elif bounce_rate >= BOUNCE_RATE_THROTTLE or failure_rate >= FAILURE_RATE_THROTTLE:
            account.health_status = "THROTTLED"
        else:
            account.health_status = "HEALTHY"

        if prev_status != account.health_status:
            logger.warning(
                f"Account {account.email} health changed: {prev_status} → {account.health_status} "
                f"(bounce={bounce_rate:.1%}, failure={failure_rate:.1%})"
            )


# ── Effective daily limit per account ─────────────────────────────────────────

def _effective_limit(account: EmailAccount) -> int:
    """Return how many emails this account can send today based on health."""
    if account.health_status == "PAUSED":
        return 0
    base = account.daily_limit
    if account.is_warming_up:
        day = min(account.warmup_day_number, WARMUP_DAYS)
        base = min(base, WARMUP_SCHEDULE.get(day, base))
    if account.health_status == "THROTTLED":
        base = math.floor(base * 0.5)
    return max(0, base - account.emails_sent_today)


# ── Main scheduler ─────────────────────────────────────────────────────────────

def _assign_sequence_variant(db: Session, lead: Lead, sequences: List[Sequence]) -> Optional[Sequence]:
    valid_sequences = [s for s in sequences if s.steps]
    if not valid_sequences:
        return None
    if len(valid_sequences) == 1:
        lead.sequence_id = valid_sequences[0].id
        db.flush()
        return valid_sequences[0]
    
    weights = [s.variant_weight if s.variant_weight is not None else 100 for s in valid_sequences]
    total_weight = sum(weights)
    if total_weight == 0:
        weights = [1] * len(valid_sequences)
        total_weight = len(valid_sequences)
        
    r = random.uniform(0, total_weight)
    current = 0
    for seq, w in zip(valid_sequences, weights):
        current += w
        if r <= current:
            lead.sequence_id = seq.id
            db.flush()
            return seq
            
    lead.sequence_id = valid_sequences[0].id
    db.flush()
    return valid_sequences[0]

def _schedule_campaign_emails(db: Session, campaign: Campaign):
    """
    Allocates the day's sending quota, then spaces each email evenly
    across the sending window for each account.
    """
    sequences = db.query(Sequence).filter(
        Sequence.campaign_id == campaign.id
    ).all()
    if not sequences:
        logger.warning(f"Campaign {campaign.id} has no sequences")
        return

    # Only use healthy/throttled/warming accounts (not PAUSED)
    active_accounts = [
        cea.email_account
        for cea in campaign.email_accounts
        if cea.is_active and cea.email_account.is_active
        and cea.email_account.health_status != "PAUSED"
    ]
    if not active_accounts:
        logger.warning(f"Campaign {campaign.id}: no available accounts to send from")
        return

    # Total capacity across all accounts today
    total_capacity = sum(_effective_limit(a) for a in active_accounts)
    if total_capacity == 0:
        logger.warning(f"Campaign {campaign.id}: all accounts at daily limit or paused")
        return

    # Apply campaign-level daily cap on top
    daily_limit = min(campaign.daily_email_limit, total_capacity)
    followup_slots = int(daily_limit * campaign.followup_percentage)
    new_lead_slots = daily_limit - followup_slots

    logger.info(
        f"Campaign {campaign.id} '{campaign.name}': "
        f"capacity={total_capacity}, followup_slots={followup_slots}, "
        f"new_lead_slots={new_lead_slots}"
    )

    # Build a balanced slot list: interleave accounts by capacity
    send_slots = _build_account_slots(active_accounts, daily_limit)

    slot_index = 0

    # ── Phase 1: Follow-ups ──────────────────────────────────────────────────
    leads_needing_followup = db.query(Lead).filter(
        Lead.campaign_id == campaign.id,
        Lead.status == LeadStatus.CONTACTED,
        Lead.is_deleted == False,
    ).all()

    leads_to_followup = []
    for lead in leads_needing_followup:
        lead_seq = lead.sequence
        if not lead_seq:
            lead_seq = _assign_sequence_variant(db, lead, sequences)
        if not lead_seq:
            continue
        
        steps = sorted(lead_seq.steps, key=lambda s: s.step_number)
        if lead.current_step < len(steps):
            leads_to_followup.append((lead, steps))

    leads_to_followup = leads_to_followup[:followup_slots]

    scheduled = 0
    for lead, steps in leads_to_followup:
        if scheduled >= followup_slots or slot_index >= len(send_slots):
            break
        step = steps[lead.current_step]
        account = send_slots[slot_index]

        existing = db.query(ScheduledEmail).filter(
            ScheduledEmail.lead_id == lead.id,
            ScheduledEmail.sequence_step_id == step.id,
            ScheduledEmail.is_sent == False,
            ScheduledEmail.is_cancelled == False,
        ).first()
        if existing:
            continue

        send_time = _calculate_spaced_send_time(
            campaign=campaign,
            account=account,
            slot_number=slot_index,
            total_slots=len(send_slots),
            delay_days_min=step.delay_days_min,
            delay_days_max=step.delay_days_max,
        )
        se = ScheduledEmail(
            lead_id=lead.id,
            campaign_id=campaign.id,
            sequence_step_id=step.id,
            email_account_id=account.id,
            scheduled_for=send_time,
        )
        db.add(se)
        scheduled += 1
        slot_index += 1

    logger.info(f"Campaign {campaign.id}: queued {scheduled} follow-ups")

    # ── Phase 2: New leads ───────────────────────────────────────────────────
    new_leads = db.query(Lead).filter(
        Lead.campaign_id == campaign.id,
        Lead.status == LeadStatus.NEW,
        Lead.is_deleted == False,
    ).limit(new_lead_slots).all()

    new_scheduled = 0
    for lead in new_leads:
        if new_scheduled >= new_lead_slots or slot_index >= len(send_slots):
            break
        
        lead_seq = lead.sequence
        if not lead_seq:
            lead_seq = _assign_sequence_variant(db, lead, sequences)
        if not lead_seq or not lead_seq.steps:
            continue

        first_step = sorted(lead_seq.steps, key=lambda s: s.step_number)[0]
        account = send_slots[slot_index]

        send_time = _calculate_spaced_send_time(
            campaign=campaign,
            account=account,
            slot_number=slot_index,
            total_slots=len(send_slots),
            delay_days_min=0,
            delay_days_max=0,
        )
        se = ScheduledEmail(
            lead_id=lead.id,
            campaign_id=campaign.id,
            sequence_step_id=first_step.id,
            email_account_id=account.id,
            scheduled_for=send_time,
        )
        db.add(se)
        new_scheduled += 1
        slot_index += 1

    logger.info(f"Campaign {campaign.id}: queued {new_scheduled} new lead emails")


# ── Smart interval calculation ─────────────────────────────────────────────────

def _build_account_slots(accounts: List[EmailAccount], total_slots: int) -> List[EmailAccount]:
    """
    Build an ordered list of account assignments for today's sends.
    Distributes proportionally to each account's remaining capacity.
    E.g. if gmail1 can send 30 and gmail2 can send 10 → 75%/25% split.
    """
    slots = []
    capacities = [(a, _effective_limit(a)) for a in accounts]
    total_cap = sum(c for _, c in capacities)
    if total_cap == 0:
        return slots

    for account, cap in capacities:
        proportion = cap / total_cap
        count = round(proportion * total_slots)
        slots.extend([account] * count)

    # Trim or pad to exact total_slots
    while len(slots) < total_slots:
        slots.append(capacities[0][0])
    slots = slots[:total_slots]

    # Shuffle so accounts are interleaved rather than batched
    # Use a seeded shuffle for reproducibility within the same day
    seed = int(datetime.utcnow().strftime("%Y%m%d"))
    rng = random.Random(seed)
    rng.shuffle(slots)

    return slots


def _calculate_spaced_send_time(
    campaign,
    account: EmailAccount,
    slot_number: int,
    total_slots: int,
    delay_days_min: int = 0,
    delay_days_max: int = 0,
) -> datetime:
    """
    Calculate the exact send time for a slot, evenly spaced across the window.
    This function is timezone-aware and uses campaign.timezone (defaults to Asia/Kolkata).
    """
    from zoneinfo import ZoneInfo
    from datetime import timezone as dt_timezone

    tz_name = campaign.timezone or "Asia/Kolkata"
    try:
        tz = ZoneInfo(tz_name)
    except Exception:
        tz = ZoneInfo("Asia/Kolkata")

    # Get current time in campaign local timezone
    now_local = datetime.now(tz)

    # Random delay for follow-ups
    delay = random.randint(delay_days_min, max(delay_days_min, delay_days_max))
    send_date_local = now_local + timedelta(days=delay)

    # Parse sending window
    start_h, start_m = map(int, campaign.sending_window_start.split(":"))
    end_h, end_m = map(int, campaign.sending_window_end.split(":"))
    window_start_mins = start_h * 60 + start_m
    window_end_mins = end_h * 60 + end_m
    window_length_mins = max(window_end_mins - window_start_mins, 1)

    # Even spacing across window
    if total_slots > 1:
        interval_mins = window_length_mins / total_slots
        offset_mins = slot_number * interval_mins
    else:
        offset_mins = window_length_mins / 2  # Single email goes mid-window

    # Small random jitter ±(interval/4) so emails don't fire at exact intervals
    if total_slots > 1:
        jitter = random.uniform(-interval_mins / 4, interval_mins / 4)
    else:
        jitter = random.uniform(-5, 5)

    total_offset = window_start_mins + offset_mins + jitter
    total_offset = max(window_start_mins, min(window_end_mins - 1, total_offset))

    send_hour = int(total_offset // 60)
    send_minute = int(total_offset % 60)
    send_second = random.randint(0, 59)

    send_time_local = send_date_local.replace(
        hour=send_hour,
        minute=send_minute,
        second=send_second,
        microsecond=0,
    )

    # If the calculated slot time has already passed today, roll it forward to tomorrow
    if send_time_local <= now_local:
        send_time_local += timedelta(days=1)

    # Advance to next active day if needed
    day_names = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
    active_days = campaign.active_days or {}
    for _ in range(14):
        day_name = day_names[send_time_local.weekday()]
        if active_days.get(day_name, True):
            break
        send_time_local += timedelta(days=1)

    # Convert to UTC and remove tzinfo to yield naive datetime representing UTC
    return send_time_local.astimezone(dt_timezone.utc).replace(tzinfo=None)


def cancel_pending_emails_for_lead(db: Session, lead_id: int, reason: str = "replied"):
    """Cancel ALL pending scheduled emails for a lead (called on reply/unsubscribe)."""
    pending = db.query(ScheduledEmail).filter(
        ScheduledEmail.lead_id == lead_id,
        ScheduledEmail.is_sent == False,
        ScheduledEmail.is_cancelled == False,
    ).all()

    count = len(pending)
    for se in pending:
        se.is_cancelled = True
        se.cancel_reason = reason

    if count:
        logger.info(f"Cancelled {count} pending emails for lead {lead_id} (reason: {reason})")

    db.commit()
    return count


def recalculate_campaign_schedule(db: Session, campaign_id: int):
    """
    Re-calculate scheduled emails when campaign settings change.
    Currently handles timezone changes and sending window updates.
    """
    campaign = db.query(Campaign).get(campaign_id)
    if not campaign:
        return

    # Update all scheduled emails with new times based on new settings
    scheduled = db.query(ScheduledEmail).filter(
        ScheduledEmail.campaign_id == campaign_id,
        ScheduledEmail.is_sent == False,
        ScheduledEmail.is_cancelled == False,
    ).all()

    for se in scheduled:
        # Re-calculate send time with new settings
        step = db.query(SequenceStep).get(se.sequence_step_id)
        account = db.query(EmailAccount).get(se.email_account_id)

        # Get all sends for this campaign to redistribute slots
        all_sends = db.query(ScheduledEmail).filter(
            ScheduledEmail.campaign_id == campaign_id,
            ScheduledEmail.is_sent == False,
            ScheduledEmail.is_cancelled == False,
        ).count()

        if step and account:
            # Find the slot index for this email
            same_account_sends = [s for s in scheduled if s.email_account_id == account.id]
            slot_index = same_account_sends.index(se)

            se.scheduled_for = _calculate_spaced_send_time(
                campaign=campaign,
                account=account,
                slot_number=slot_index,
                total_slots=len(scheduled),
                delay_days_min=step.delay_days_min,
                delay_days_max=step.delay_days_max,
            )

    logger.info(f"Recalculated schedule for campaign {campaign_id}: {len(scheduled)} emails rescheduled")


def apply_campaign_change_event(db: Session, event_id: int):
    from app.models import CampaignChangeEvent, ScheduledEmail, Campaign, SequenceStep, EmailAccount
    event = db.query(CampaignChangeEvent).get(event_id)
    if not event or event.applied_at is not None:
        return
        
    campaign = db.query(Campaign).get(event.campaign_id)
    if not campaign:
        return
        
    if event.change_type == "daily_email_limit":
        old_val = int(event.old_value) if event.old_value else 50
        new_val = int(event.new_value) if event.new_value else 50
        if new_val < old_val:
            today_start = datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
            today_end = today_start + timedelta(days=1)
            scheduled_today = db.query(ScheduledEmail).filter(
                ScheduledEmail.campaign_id == campaign.id,
                ScheduledEmail.is_sent == False,
                ScheduledEmail.is_cancelled == False,
                ScheduledEmail.scheduled_for >= today_start,
                ScheduledEmail.scheduled_for < today_end
            ).all()
            
            if len(scheduled_today) > new_val:
                excess_count = len(scheduled_today) - new_val
                cancelled_count = 0
                for se in scheduled_today[-excess_count:]:
                    se.is_cancelled = True
                    se.cancel_reason = "campaign_limit_reduced"
                    cancelled_count += 1
                event.cascade_result = f"Cancelled {cancelled_count} excess emails for today"
            else:
                event.cascade_result = "No excess emails found to cancel today"
        else:
            event.cascade_result = "Daily limit increased"

    elif event.change_type in ("sending_window", "active_days", "timezone"):
        recalculate_campaign_schedule(db, campaign.id)
        rescheduled_count = db.query(ScheduledEmail).filter(
            ScheduledEmail.campaign_id == campaign.id,
            ScheduledEmail.is_sent == False,
            ScheduledEmail.is_cancelled == False,
        ).count()
        event.cascade_result = f"Rescheduled {rescheduled_count} future emails"
        
    elif event.change_type == "sequence_step_deleted":
        step_id = int(event.new_value)
        to_cancel = db.query(ScheduledEmail).filter(
            ScheduledEmail.campaign_id == campaign.id,
            ScheduledEmail.sequence_step_id == step_id,
            ScheduledEmail.is_sent == False,
            ScheduledEmail.is_cancelled == False,
        ).all()
        for se in to_cancel:
            se.is_cancelled = True
            se.cancel_reason = "sequence_step_deleted"
        event.cascade_result = f"Cancelled {len(to_cancel)} scheduled emails for deleted step"
        
    elif event.change_type == "sequence_step_edited":
        recalculate_campaign_schedule(db, campaign.id)
        event.cascade_result = "Recalculated schedule due to step edits"
        
    else:
        event.cascade_result = "No cascade action required"
        
    event.applied_at = datetime.utcnow()
    db.commit()

