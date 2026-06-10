from sqlalchemy import (
    Column, Integer, String, Boolean, DateTime, Text,
    ForeignKey, JSON, Enum, Float
)
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
import enum
from app.core.database import Base


class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True)
    email = Column(String(255), unique=True, nullable=False, index=True)
    hashed_password = Column(String(255), nullable=False)
    full_name = Column(String(255))
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    campaigns = relationship("Campaign", back_populates="owner")
    email_accounts = relationship("EmailAccount", back_populates="owner")


class CampaignStatus(str, enum.Enum):
    DRAFT = "DRAFT"
    ACTIVE = "ACTIVE"
    PAUSED = "PAUSED"
    COMPLETED = "COMPLETED"


class Campaign(Base):
    __tablename__ = "campaigns"
    id = Column(Integer, primary_key=True)
    owner_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    name = Column(String(255), nullable=False)
    status = Column(Enum(CampaignStatus), default=CampaignStatus.DRAFT)

    # Sending schedule
    active_days = Column(JSON, default=lambda: {
        "monday": True, "tuesday": True, "wednesday": True,
        "thursday": True, "friday": True, "saturday": False, "sunday": False
    })
    sending_window_start = Column(String(5), default="09:00")  # "HH:MM"
    sending_window_end = Column(String(5), default="17:00")

    # Limits
    daily_new_leads = Column(Integer, default=20)
    followup_percentage = Column(Float, default=0.7)  # 70% followups, 30% new
    daily_email_limit = Column(Integer, default=50)

    # Timezone
    timezone = Column(String(100), default="Asia/Kolkata")  # IST

    # Tracking preferences - disable for better deliverability
    track_open_rate = Column(Boolean, default=True)
    track_reply_rate = Column(Boolean, default=True)

    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())

    owner = relationship("User", back_populates="campaigns")
    leads = relationship("Lead", back_populates="campaign")
    sequences = relationship("Sequence", back_populates="campaign")
    email_accounts = relationship("CampaignEmailAccount", back_populates="campaign")

class CampaignEmailAccount(Base):
    """Many-to-many: campaigns can use multiple email accounts.
    An email account can only be actively assigned to ONE campaign at a time.
    """
    __tablename__ = "campaign_email_accounts"
    id = Column(Integer, primary_key=True)
    campaign_id = Column(Integer, ForeignKey("campaigns.id"))
    email_account_id = Column(Integer, ForeignKey("email_accounts.id"))
    is_active = Column(Boolean, default=True)  # False = removed from campaign
    assigned_at = Column(DateTime(timezone=True), server_default=func.now())
    campaign = relationship("Campaign", back_populates="email_accounts")
    email_account = relationship("EmailAccount")


class LeadStatus(str, enum.Enum):
    # ── Basic states ──────────────────────────────────────────────────────────
    NEW          = "NEW"
    CONTACTED    = "CONTACTED"
    REPLIED      = "REPLIED"
    BOUNCED      = "BOUNCED"
    UNSUBSCRIBED = "UNSUBSCRIBED"
    COMPLETED    = "COMPLETED"
    OPTED_OUT    = "OPTED_OUT"

    # ── Qualified states (set manually or auto-detected) ──────────────────────
    INTERESTED      = "INTERESTED"
    MEETING_BOOKED  = "MEETING_BOOKED"

    # ── Disqualified states ───────────────────────────────────────────────────
    NOT_INTERESTED  = "NOT_INTERESTED"
    WRONG_PERSON    = "WRONG_PERSON"
    DO_NOT_CONTACT  = "DO_NOT_CONTACT"

    # ── Temporary states (auto-detected from reply content) ───────────────────
    OUT_OF_OFFICE   = "OUT_OF_OFFICE"
    


class Lead(Base):
    __tablename__ = "leads"
    id = Column(Integer, primary_key=True)
    campaign_id = Column(Integer, ForeignKey("campaigns.id"), nullable=False)
    first_name = Column(String(255))
    last_name = Column(String(255))
    email = Column(String(255), nullable=False, index=True)
    company = Column(String(255))
    website = Column(String(500))
    custom_fields = Column(JSON, default=dict)  # Any extra CSV columns
    status = Column(Enum(LeadStatus), default=LeadStatus.NEW, index=True)
    current_step = Column(Integer, default=0)  # Which sequence step they're on
    contacted_at     = Column(DateTime(timezone=True))
    replied_at       = Column(DateTime(timezone=True))
    status_changed_at = Column(DateTime(timezone=True))
    status_note      = Column(Text)           # Manual note when changing status
    status_changed_by = Column(String(50))    # "auto" | "user"
    sequence_id = Column(Integer, ForeignKey("sequences.id"), nullable=True)
    is_deleted = Column(Boolean, default=False, server_default='false', index=True)
    created_at       = Column(DateTime(timezone=True), server_default=func.now())

    campaign = relationship("Campaign", back_populates="leads")
    sequence = relationship("Sequence")
    email_events = relationship("EmailEvent", back_populates="lead")
    conversation = relationship("Conversation", back_populates="lead", uselist=False)
    scheduled_emails = relationship("ScheduledEmail", back_populates="lead")


class EmailAccount(Base):
    __tablename__ = "email_accounts"
    id = Column(Integer, primary_key=True)
    owner_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    name = Column(String(255))
    email = Column(String(255), nullable=False)

    # SMTP settings
    smtp_host = Column(String(255), nullable=False)
    smtp_port = Column(Integer, default=587)
    smtp_username = Column(String(255), nullable=False)
    smtp_password_encrypted = Column(Text, nullable=False)
    use_tls = Column(Boolean, default=True)

    # IMAP for reply detection
    imap_host = Column(String(255))
    imap_port = Column(Integer, default=993)
    imap_use_ssl = Column(Boolean, default=True)

    # Daily limits & counters
    daily_limit = Column(Integer, default=50)
    emails_sent_today = Column(Integer, default=0)
    last_reset_date = Column(String(10))  # YYYY-MM-DD

    # ── Health tracking ──────────────────────────────────────────────────────
    # Rolling 7-day counters (reset weekly)
    bounces_this_week = Column(Integer, default=0)
    failures_this_week = Column(Integer, default=0)
    sends_this_week = Column(Integer, default=0)
    last_week_reset = Column(String(10))  # YYYY-MM-DD

    # Health state: HEALTHY | WARMING | THROTTLED | PAUSED
    health_status = Column(String(20), default="HEALTHY")

    # Warm-up mode: ramp daily_limit up over time for new accounts
    is_warming_up = Column(Boolean, default=False)
    warmup_start_date = Column(String(10))   # YYYY-MM-DD
    warmup_day_number = Column(Integer, default=1)

    # Last time an email was sent from this account (for interval enforcement)
    last_sent_at = Column(DateTime(timezone=True))

    is_active = Column(Boolean, default=True)
    provider = Column(String(50), default="custom")
    oauth_token = Column(JSON, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    owner = relationship("User", back_populates="email_accounts")

class Sequence(Base):
    __tablename__ = "sequences"
    id = Column(Integer, primary_key=True)
    campaign_id = Column(Integer, ForeignKey("campaigns.id"), nullable=False)
    name = Column(String(255), default="Main Sequence")

    # Multi-variant support
    is_main_variant = Column(Boolean, default=False)
    variant_weight = Column(Integer, default=100)  # Percentage for A/B testing

    created_at = Column(DateTime(timezone=True), server_default=func.now())

    campaign = relationship("Campaign", back_populates="sequences")
    steps = relationship("SequenceStep", back_populates="sequence", order_by="SequenceStep.step_number")
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    campaign = relationship("Campaign", back_populates="sequences")
    steps = relationship("SequenceStep", back_populates="sequence", order_by="SequenceStep.step_number")


class SequenceStep(Base):
    __tablename__ = "sequence_steps"
    id = Column(Integer, primary_key=True)
    sequence_id = Column(Integer, ForeignKey("sequences.id"), nullable=False)
    step_number = Column(Integer, nullable=False)  # 1, 2, 3...

    # Dynamic delay: e.g. {"min_days": 2, "max_days": 4}
    delay_days_min = Column(Integer, default=0)
    delay_days_max = Column(Integer, default=0)

    subject = Column(String(500), nullable=True)
    body = Column(Text, nullable=False)
    is_plain_text = Column(Boolean, default=True)  # Plain text for deliverability

    sequence = relationship("Sequence", back_populates="steps")
    attachments = relationship("Attachment", back_populates="sequence_step")


class EmailEventType(str, enum.Enum):
    SENT = "SENT"
    OPENED = "OPENED"
    CLICKED = "CLICKED"
    REPLIED = "REPLIED"
    BOUNCED = "BOUNCED"
    FAILED = "FAILED"


class EmailEvent(Base):
    __tablename__ = "email_events"
    id = Column(Integer, primary_key=True)
    lead_id = Column(Integer, ForeignKey("leads.id"), nullable=False)
    campaign_id = Column(Integer, ForeignKey("campaigns.id"), nullable=False)
    email_account_id = Column(Integer, ForeignKey("email_accounts.id"))
    sequence_step_id = Column(Integer, ForeignKey("sequence_steps.id"))
    event_type = Column(Enum(EmailEventType), nullable=False)
    message_id = Column(String(500))  # SMTP message ID for threading
    error_message = Column(Text)
    timestamp = Column(DateTime(timezone=True), server_default=func.now())

    lead = relationship("Lead", back_populates="email_events")


class ScheduledEmail(Base):
    """Queue of emails to be sent at specific times"""
    __tablename__ = "scheduled_emails"
    id = Column(Integer, primary_key=True)
    lead_id = Column(Integer, ForeignKey("leads.id"), nullable=False)
    campaign_id = Column(Integer, ForeignKey("campaigns.id"), nullable=False)
    sequence_step_id = Column(Integer, ForeignKey("sequence_steps.id"), nullable=False)
    email_account_id = Column(Integer, ForeignKey("email_accounts.id"))
    scheduled_for = Column(DateTime(timezone=True), nullable=False, index=True)
    sent_at = Column(DateTime(timezone=True))
    is_sent = Column(Boolean, default=False)
    is_cancelled = Column(Boolean, default=False)
    cancel_reason = Column(String(255))
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    lead = relationship("Lead", back_populates="scheduled_emails")


class Conversation(Base):
    """Master inbox: one conversation per lead"""
    __tablename__ = "conversations"
    id = Column(Integer, primary_key=True)
    lead_id = Column(Integer, ForeignKey("leads.id"), unique=True, nullable=False)
    campaign_id = Column(Integer, ForeignKey("campaigns.id"), nullable=False)
    last_message_at = Column(DateTime(timezone=True))
    has_unread = Column(Boolean, default=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    lead = relationship("Lead", back_populates="conversation")
    messages = relationship("Message", back_populates="conversation", order_by="Message.timestamp")


class MessageDirection(str, enum.Enum):
    INBOUND = "INBOUND"
    OUTBOUND = "OUTBOUND"


class Message(Base):
    __tablename__ = "messages"
    id = Column(Integer, primary_key=True)
    conversation_id = Column(Integer, ForeignKey("conversations.id"), nullable=False)
    direction = Column(Enum(MessageDirection), nullable=False)
    subject = Column(String(500))
    body = Column(Text, nullable=False)
    message_id = Column(String(500))  # Email Message-ID header
    timestamp = Column(DateTime(timezone=True), server_default=func.now())

    conversation = relationship("Conversation", back_populates="messages")


class Attachment(Base):
    """Email attachments for sequence steps"""
    __tablename__ = "attachments"
    id = Column(Integer, primary_key=True)
    campaign_id = Column(Integer, ForeignKey("campaigns.id"), nullable=False)
    sequence_step_id = Column(Integer, ForeignKey("sequence_steps.id"))
    filename = Column(String(255), nullable=False)
    file_path = Column(String(500), nullable=False)  # Local storage or S3
    file_size = Column(Integer)
    mime_type = Column(String(100))
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    campaign = relationship("Campaign")
    sequence_step = relationship("SequenceStep", back_populates="attachments")


class CampaignChangeEvent(Base):
    __tablename__ = "campaign_change_events"
    id = Column(Integer, primary_key=True)
    campaign_id = Column(Integer, ForeignKey("campaigns.id"), nullable=False)
    change_type = Column(String(50), nullable=False)  # "daily_email_limit", "sending_window", "timezone", "active_days", "sequence"
    old_value = Column(Text)
    new_value = Column(Text)
    changed_by = Column(String(255))
    applied_at = Column(DateTime(timezone=True))
    cascade_result = Column(Text)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
