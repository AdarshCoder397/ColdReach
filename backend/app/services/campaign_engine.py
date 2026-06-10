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

        existing = db.query(ScheduledEmail).filter(
            ScheduledEmail.lead_id == lead.id,
            ScheduledEmail.sequence_step_id == first_step.id,
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
    db.flush()
    reschedule_pending_emails(db, campaign.id)


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
    Supports windows that span across midnight and prevents scheduling slots in the past.
    """
    from zoneinfo import ZoneInfo
    from datetime import timezone as dt_timezone, time, timedelta
    import random

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
    try:
        start_h, start_m = map(int, campaign.sending_window_start.split(":"))
        end_h, end_m = map(int, campaign.sending_window_end.split(":"))
    except Exception:
        start_h, start_m = 9, 0
        end_h, end_m = 17, 0

    window_start_mins = start_h * 60 + start_m
    window_end_mins = end_h * 60 + end_m
    
    # Check if window crosses midnight
    if window_end_mins < window_start_mins:
        window_end_mins += 1440

    # Calculate current local time in minutes relative to the start of send_date_local
    start_of_date_local = datetime.combine(send_date_local.date(), datetime.min.time()).replace(tzinfo=tz)
    now_mins = (now_local - start_of_date_local).total_seconds() / 60

    # If we are scheduling for today/the current active session, clamp the window start to the future
    if now_mins > window_start_mins:
        # Give a 2-minute buffer so emails are scheduled starting 2 minutes from now
        window_start_mins = max(window_start_mins, now_mins + 2)

    window_length_mins = max(window_end_mins - window_start_mins, 1)

    # Even spacing across window
    if total_slots > 1:
        interval_mins = window_length_mins / total_slots
        offset_mins = slot_number * interval_mins
    else:
        offset_mins = window_length_mins / 2  # Single email goes mid-window

    # Small random jitter so emails don't fire at exact intervals
    if total_slots > 1:
        jitter = random.uniform(-interval_mins / 4, interval_mins / 4)
    else:
        jitter = random.uniform(-5, 5)

    total_offset = window_start_mins + offset_mins + jitter
    total_offset = max(window_start_mins, min(window_end_mins - 1, total_offset))

    # Handle overflow if slot spills over midnight
    target_date = send_date_local.date()
    if total_offset >= 1440:
        target_date = target_date + timedelta(days=1)
        total_offset -= 1440

    send_hour = int(total_offset // 60)
    send_minute = int(total_offset % 60)
    send_second = random.randint(0, 59)

    # Combine target_date with local time
    send_time_local = datetime.combine(
        target_date,
        time(hour=send_hour, minute=send_minute, second=send_second)
    )
    send_time_local = send_time_local.replace(tzinfo=tz)

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


def _calculate_spaced_time_for_date(
    campaign,
    date_obj,
    slot_number: int,
    total_slots: int,
) -> datetime:
    """
    Calculate the exact send time for a slot on a specific date, evenly spaced across the window.
    Supports sending windows that span across midnight and prevents scheduling slots in the past.
    """
    from zoneinfo import ZoneInfo
    from datetime import timezone as dt_timezone, time, timedelta
    import random

    tz_name = campaign.timezone or "Asia/Kolkata"
    try:
        tz = ZoneInfo(tz_name)
    except Exception:
        tz = ZoneInfo("Asia/Kolkata")

    # Parse sending window
    try:
        start_h, start_m = map(int, campaign.sending_window_start.split(":"))
        end_h, end_m = map(int, campaign.sending_window_end.split(":"))
    except Exception:
        start_h, start_m = 9, 0
        end_h, end_m = 17, 0

    window_start_mins = start_h * 60 + start_m
    window_end_mins = end_h * 60 + end_m
    
    # Check if window crosses midnight
    if window_end_mins < window_start_mins:
        window_end_mins += 1440

    # Calculate current local time in minutes relative to the start of date_obj
    now_local = datetime.now(tz)
    start_of_date_local = datetime.combine(date_obj, time.min).replace(tzinfo=tz)
    now_mins = (now_local - start_of_date_local).total_seconds() / 60

    # If we are scheduling for today/the current active session, clamp the window start to the future
    if now_mins > window_start_mins:
        # Give a 2-minute buffer so emails are scheduled starting 2 minutes from now
        window_start_mins = max(window_start_mins, now_mins + 2)

    window_length_mins = max(window_end_mins - window_start_mins, 1)

    # Even spacing across window
    if total_slots > 1:
        interval_mins = window_length_mins / total_slots
        offset_mins = slot_number * interval_mins
    else:
        offset_mins = window_length_mins / 2  # Single email goes mid-window

    # Small random jitter so emails don't fire at exact intervals
    if total_slots > 1:
        jitter = random.uniform(-interval_mins / 4, interval_mins / 4)
    else:
        jitter = random.uniform(-5, 5)

    total_offset = window_start_mins + offset_mins + jitter
    total_offset = max(window_start_mins, min(window_end_mins - 1, total_offset))

    # Handle overflow if slot spills over midnight
    target_date = date_obj
    if total_offset >= 1440:
        target_date = date_obj + timedelta(days=1)
        total_offset -= 1440

    send_hour = int(total_offset // 60)
    send_minute = int(total_offset % 60)
    send_second = random.randint(0, 59)

    # Combine target_date with local time
    send_time_local = datetime.combine(
        target_date,
        time(hour=send_hour, minute=send_minute, second=send_second)
    )
    send_time_local = send_time_local.replace(tzinfo=tz)

    # Convert to UTC and remove tzinfo to yield naive datetime representing UTC
    return send_time_local.astimezone(dt_timezone.utc).replace(tzinfo=None)


def reschedule_pending_emails(db: Session, campaign_id: int):
    """
    Redistribute all pending scheduled emails day-by-day based on campaign daily limits.
    Enforces total daily limit, max new leads limit, and max follow-ups limit.
    Spaces emails evenly across the window for each day.
    """
    from zoneinfo import ZoneInfo
    from datetime import timezone as dt_timezone
    from collections import defaultdict

    campaign = db.query(Campaign).get(campaign_id)
    if not campaign:
        return

    tz_name = campaign.timezone or "Asia/Kolkata"
    try:
        tz = ZoneInfo(tz_name)
    except Exception:
        tz = ZoneInfo("Asia/Kolkata")

    # Get current time in campaign timezone
    now_local = datetime.now(tz)
    today_local = now_local.date()

    # Get window end time today to determine if today's window is already closed
    try:
        end_h, end_m = map(int, campaign.sending_window_end.split(":"))
        start_h, start_m = map(int, campaign.sending_window_start.split(":"))
    except Exception:
        end_h, end_m = 17, 0
        start_h, start_m = 9, 0

    from datetime import time, timedelta
    session_end_local = datetime.combine(today_local, time(hour=end_h, minute=end_m)).replace(tzinfo=tz)
    # Check if window crosses midnight
    if (end_h * 60 + end_m) < (start_h * 60 + start_m):
        session_end_local += timedelta(days=1)

    if now_local >= session_end_local:
        earliest_date = today_local + timedelta(days=1)
    else:
        earliest_date = today_local

    # Fetch sent emails count for today
    sent_followups = 0
    sent_new_leads = 0
    try:
        local_start = datetime.combine(today_local, datetime.min.time()).replace(tzinfo=tz)
        local_end = datetime.combine(today_local, datetime.max.time()).replace(tzinfo=tz)
        utc_start = local_start.astimezone(dt_timezone.utc).replace(tzinfo=None)
        utc_end = local_end.astimezone(dt_timezone.utc).replace(tzinfo=None)

        sent_today_emails = db.query(ScheduledEmail, SequenceStep).join(
            SequenceStep, ScheduledEmail.sequence_step_id == SequenceStep.id
        ).filter(
            ScheduledEmail.campaign_id == campaign_id,
            ScheduledEmail.is_sent == True,
            ScheduledEmail.sent_at >= utc_start,
            ScheduledEmail.sent_at <= utc_end
        ).all()

        for se, step in sent_today_emails:
            if step.step_number > 1:
                sent_followups += 1
            else:
                sent_new_leads += 1
    except Exception as e:
        logger.error(f"Error querying sent emails for today: {e}", exc_info=True)

    # Load all pending scheduled emails with their sequence steps
    pending = db.query(ScheduledEmail, SequenceStep).join(
        SequenceStep, ScheduledEmail.sequence_step_id == SequenceStep.id
    ).filter(
        ScheduledEmail.campaign_id == campaign_id,
        ScheduledEmail.is_sent == False,
        ScheduledEmail.is_cancelled == False
    ).all()

    if not pending:
        logger.info(f"No pending emails to reschedule for campaign {campaign_id}")
        return

    # Calculate limits
    daily_limit = max(1, campaign.daily_email_limit or 250)
    followup_percentage = campaign.followup_percentage if campaign.followup_percentage is not None else 0.40
    max_followups_per_day = max(0, int(daily_limit * followup_percentage))
    max_new_leads_per_day = max(1, daily_limit - max_followups_per_day)

    # Sort pending emails: desired date local ascending, follow-ups first (step > 1), then original time
    def get_sort_key(item):
        se, step = item
        try:
            dt = se.scheduled_for
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=ZoneInfo("UTC"))
            else:
                dt = dt.astimezone(ZoneInfo("UTC"))
            dt_local = dt.astimezone(tz)
            local_date = dt_local.date()
            dt_naive = dt.replace(tzinfo=None)
        except Exception:
            local_date = today_local
            dt_naive = datetime.min
        desired_date = max(local_date, earliest_date)
        is_followup = step.step_number > 1
        return (desired_date, 0 if is_followup else 1, dt_naive)

    pending_sorted = sorted(pending, key=get_sort_key)

    daily_counts = {}
    assigned_emails = []  # list of (se, step, assigned_date)

    active_days = campaign.active_days or {}
    day_names = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]

    def is_active_day(date_obj):
        day_name = day_names[date_obj.weekday()]
        return active_days.get(day_name, True)

    for se, step in pending_sorted:
        is_followup = step.step_number > 1
        try:
            dt = se.scheduled_for
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=ZoneInfo("UTC"))
            else:
                dt = dt.astimezone(ZoneInfo("UTC"))
            dt_local = dt.astimezone(tz)
            local_date = dt_local.date()
        except Exception:
            local_date = today_local
        current_date = max(local_date, earliest_date)

        safety_counter = 0
        while safety_counter < 365:
            safety_counter += 1
            if not is_active_day(current_date):
                current_date += timedelta(days=1)
                continue

            if current_date not in daily_counts:
                if current_date == today_local:
                    daily_counts[current_date] = {
                        "followups": sent_followups,
                        "new_leads": sent_new_leads
                    }
                else:
                    daily_counts[current_date] = {
                        "followups": 0,
                        "new_leads": 0
                    }

            counts = daily_counts[current_date]
            total_scheduled = counts["followups"] + counts["new_leads"]

            if total_scheduled < daily_limit:
                if is_followup and counts["followups"] < max_followups_per_day:
                    counts["followups"] += 1
                    assigned_emails.append((se, step, current_date))
                    break
                elif not is_followup and counts["new_leads"] < max_new_leads_per_day:
                    counts["new_leads"] += 1
                    assigned_emails.append((se, step, current_date))
                    break

            current_date += timedelta(days=1)

    # Group assigned emails by date to space them out
    emails_by_date = defaultdict(list)
    for se, step, date_obj in assigned_emails:
        emails_by_date[date_obj].append((se, step))

    # For each date, space them evenly
    for date_obj, day_emails in emails_by_date.items():
        by_account = defaultdict(list)
        for se, step in day_emails:
            by_account[se.email_account_id].append((se, step))

        interleaved = []
        accounts_lists = list(by_account.values())
        max_len = max(len(lst) for lst in accounts_lists) if accounts_lists else 0
        for i in range(max_len):
            for lst in accounts_lists:
                if i < len(lst):
                    interleaved.append(lst[i])

        total_slots = len(interleaved)
        for slot_index, (se, step) in enumerate(interleaved):
            se.scheduled_for = _calculate_spaced_time_for_date(
                campaign=campaign,
                date_obj=date_obj,
                slot_number=slot_index,
                total_slots=total_slots,
            )

    db.flush()
    logger.info(f"Rescheduled {len(assigned_emails)} emails across future active days for campaign {campaign_id}")


def recalculate_campaign_schedule(db: Session, campaign_id: int):
    """
    Re-calculate scheduled emails when campaign settings change.
    delegates scheduling/limits to reschedule_pending_emails.
    """
    reschedule_pending_emails(db, campaign_id)


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

