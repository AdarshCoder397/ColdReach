from pydantic import BaseModel, EmailStr, field_validator
from typing import Optional, List, Dict, Any
from datetime import datetime
from enum import Enum


# ─── Auth ────────────────────────────────────────────────────────────────────

class UserCreate(BaseModel):
    email: EmailStr
    password: str
    full_name: Optional[str] = None

class UserOut(BaseModel):
    id: int
    email: str
    full_name: Optional[str]
    is_active: bool
    created_at: datetime
    class Config:
        from_attributes = True

class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserOut


# ─── Campaign ────────────────────────────────────────────────────────────────

class ActiveDays(BaseModel):
    monday: bool = True
    tuesday: bool = True
    wednesday: bool = True
    thursday: bool = True
    friday: bool = True
    saturday: bool = False
    sunday: bool = False

class CampaignCreate(BaseModel):
    name: str
    active_days: Optional[ActiveDays] = None
    sending_window_start: str = "09:00"
    sending_window_end: str = "17:00"
    daily_new_leads: int = 20
    followup_percentage: float = 0.7
    daily_email_limit: int = 50
    timezone: str = "Asia/Kolkata"  # IST default
    track_open_rate: Optional[bool] = True
    track_reply_rate: Optional[bool] = True

class CampaignUpdate(BaseModel):
    name: Optional[str] = None
    status: Optional[str] = None
    active_days: Optional[ActiveDays] = None
    sending_window_start: Optional[str] = None
    sending_window_end: Optional[str] = None
    daily_new_leads: Optional[int] = None
    followup_percentage: Optional[float] = None
    daily_email_limit: Optional[int] = None
    timezone: Optional[str] = None
    track_open_rate: Optional[bool] = None
    track_reply_rate: Optional[bool] = None

class CampaignOut(BaseModel):
    id: int
    name: str
    status: str
    active_days: Dict
    sending_window_start: str
    sending_window_end: str
    daily_new_leads: int
    followup_percentage: float
    daily_email_limit: int
    timezone: str
    track_open_rate: bool
    track_reply_rate: bool
    created_at: datetime
    lead_count: Optional[int] = 0
    sent_count: Optional[int] = 0
    reply_count: Optional[int] = 0
    progress_percentage: Optional[float] = 0.0
    class Config:
        from_attributes = True


# ─── Email Account ────────────────────────────────────────────────────────────

class EmailAccountCreate(BaseModel):
    name: str
    email: EmailStr
    smtp_host: str
    smtp_port: int = 587
    smtp_username: str
    smtp_password: str  # Plain — will be encrypted before storage
    use_tls: bool = True
    imap_host: Optional[str] = None
    imap_port: int = 993
    imap_use_ssl: bool = True
    daily_limit: int = 50
    is_warming_up: Optional[bool] = False

class EmailAccountOut(BaseModel):
    id: int
    name: str
    email: str
    smtp_host: str
    smtp_port: int
    smtp_username: str
    use_tls: bool
    imap_host: Optional[str]
    imap_port: Optional[int]
    imap_use_ssl: Optional[bool]
    daily_limit: int
    emails_sent_today: int
    is_active: bool
    is_warming_up: bool
    warmup_start_date: Optional[str]
    health_status: str
    provider: str
    created_at: datetime
    class Config:
        from_attributes = True


class EmailAccountUpdate(BaseModel):
    name: Optional[str] = None
    email: Optional[EmailStr] = None
    smtp_host: Optional[str] = None
    smtp_port: Optional[int] = None
    smtp_username: Optional[str] = None
    smtp_password: Optional[str] = None
    use_tls: Optional[bool] = None
    imap_host: Optional[str] = None
    imap_port: Optional[int] = None
    imap_use_ssl: Optional[bool] = None
    daily_limit: Optional[int] = None
    is_active: Optional[bool] = None
    is_warming_up: Optional[bool] = None
    warmup_start_date: Optional[str] = None


class EmailAccountsBulkUpdate(BaseModel):
    account_ids: List[int]
    daily_limit: Optional[int] = None
    is_active: Optional[bool] = None
    is_warming_up: Optional[bool] = None


# ─── Sequence ─────────────────────────────────────────────────────────────────

class SequenceStepCreate(BaseModel):
    step_number: int
    delay_days_min: int = 0
    delay_days_max: int = 0
    subject: Optional[str] = ""
    body: str
    is_plain_text: bool = True

class SequenceStepOut(BaseModel):
    id: int
    step_number: int
    delay_days_min: int
    delay_days_max: int
    subject: Optional[str] = None
    body: str
    is_plain_text: bool
    class Config:
        from_attributes = True

class SequenceCreate(BaseModel):
    name: str = "Main Sequence"
    steps: List[SequenceStepCreate]
    variant_weight: Optional[int] = None
    is_main_variant: Optional[bool] = False

class SequenceOut(BaseModel):
    id: int
    name: str
    campaign_id: int
    steps: List[SequenceStepOut]
    is_main_variant: bool = False
    variant_weight: Optional[int] = None
    class Config:
        from_attributes = True


# ─── Lead ─────────────────────────────────────────────────────────────────────

class LeadCreate(BaseModel):
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    email: EmailStr
    company: Optional[str] = None
    website: Optional[str] = None
    custom_fields: Optional[Dict[str, Any]] = {}
    sequence_id: Optional[int] = None

class LeadOut(BaseModel):
    id: int
    campaign_id: int
    first_name: Optional[str]
    last_name: Optional[str]
    email: str
    company: Optional[str]
    website: Optional[str] = None
    status: str
    current_step: int
    custom_fields: Optional[Dict[str, Any]] = {}
    sequence_id: Optional[int] = None
    created_at: datetime
    class Config:
        from_attributes = True

class LeadImportResult(BaseModel):
    imported: int
    duplicates: int
    errors: int


# ─── Master Inbox ─────────────────────────────────────────────────────────────

class MessageOut(BaseModel):
    id: int
    direction: str
    subject: Optional[str]
    body: str
    timestamp: datetime
    class Config:
        from_attributes = True

class ConversationOut(BaseModel):
    id: int
    lead: LeadOut
    campaign_id: int
    last_message_at: Optional[datetime]
    has_unread: bool
    messages: List[MessageOut] = []
    class Config:
        from_attributes = True


# ─── Analytics ────────────────────────────────────────────────────────────────

class CampaignStats(BaseModel):
    total_leads: int
    contacted: int
    replied: int
    bounced: int
    reply_rate: float
    emails_sent: int
    pending_emails: int


class ActivityEventOut(BaseModel):
    id: int
    event_type: str          # SENT, FAILED, CANCELLED, SCHEDULED, REPLIED, BOUNCED
    lead_email: str
    lead_name: Optional[str]
    sequence_step: Optional[int]
    email_account: Optional[str]
    scheduled_for: Optional[datetime]
    sent_at: Optional[datetime]
    timestamp: datetime
    cancel_reason: Optional[str]
    error_message: Optional[str]
    is_sent: Optional[bool]
    is_cancelled: Optional[bool]

    class Config:
        from_attributes = True


class ActivityFeedOut(BaseModel):
    events: List[ActivityEventOut]
    total: int
    has_more: bool


# ─── Campaign Export/Import ──────────────────────────────────────────────────

class CampaignExportSettings(BaseModel):
    name: str
    active_days: ActiveDays
    sending_window_start: str
    sending_window_end: str
    daily_new_leads: int
    followup_percentage: float
    daily_email_limit: int
    timezone: str
    track_open_rate: bool
    track_reply_rate: bool

class SequenceStepImportExport(BaseModel):
    step_number: int
    delay_days_min: int = 0
    delay_days_max: int = 0
    subject: Optional[str] = ""
    body: str
    is_plain_text: bool = True

class SequenceImportExport(BaseModel):
    name: str = "Main Sequence"
    is_main_variant: bool = False
    variant_weight: Optional[int] = 100
    steps: List[SequenceStepImportExport]

class CampaignImportExport(BaseModel):
    settings: CampaignExportSettings
    sequences: List[SequenceImportExport]


# ─── Bulk Import Email Accounts ───────────────────────────────────────────────

class EmailAccountImportResultItem(BaseModel):
    email: str
    status: str  # "success" or "failed"
    error: Optional[str] = None

class EmailAccountsBulkImportResult(BaseModel):
    imported: int
    failed: int
    results: List[EmailAccountImportResultItem]