"""
All API routes. Organized by resource.
"""
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, status
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy.orm import Session
from typing import List, Optional
import pandas as pd
import io
from datetime import datetime

from app.core.database import get_db
from app.core.security import (
    hash_password, verify_password,
    create_access_token, get_current_user
)
from app.core.encryption import encrypt_password
from app.models import (
    User, Campaign, Lead, LeadStatus, EmailAccount,
    Sequence, SequenceStep, Conversation, EmailEvent,
    ScheduledEmail, CampaignEmailAccount, Attachment,
    EmailEventType
)
from app.schemas import (
    UserCreate, UserOut, Token,
    CampaignCreate, CampaignUpdate, CampaignOut, CampaignImportExport,
    EmailAccountCreate, EmailAccountOut, EmailAccountUpdate, EmailAccountsBulkUpdate,
    SequenceCreate, SequenceOut,
    LeadCreate, LeadOut, LeadImportResult,
    ConversationOut, CampaignStats,
    ActivityEventOut, ActivityFeedOut,   # ← add this line
)



router = APIRouter()


# ─── Auth ─────────────────────────────────────────────────────────────────────

@router.post("/auth/register", response_model=UserOut)
def register(payload: UserCreate, db: Session = Depends(get_db)):
    if db.query(User).filter(User.email == payload.email).first():
        raise HTTPException(400, "Email already registered")
    user = User(
        email=payload.email,
        hashed_password=hash_password(payload.password),
        full_name=payload.full_name,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


@router.post("/auth/login", response_model=Token)
def login(form_data: OAuth2PasswordRequestForm = Depends(), db: Session = Depends(get_db)):
    user = db.query(User).filter(User.email == form_data.username).first()
    if not user or not verify_password(form_data.password, user.hashed_password):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid credentials")
    token = create_access_token({"sub": str(user.id)})
    return Token(access_token=token, user=UserOut.model_validate(user))


@router.get("/auth/me", response_model=UserOut)
def me(current_user: User = Depends(get_current_user)):
    return current_user


# ─── Campaigns ────────────────────────────────────────────────────────────────

def _populate_campaign_metrics(db: Session, c: Campaign, out: CampaignOut):
    from sqlalchemy import func
    
    out.lead_count = db.query(Lead).filter(Lead.campaign_id == c.id, Lead.is_deleted == False).count()
    out.sent_count = db.query(EmailEvent).filter(
        EmailEvent.campaign_id == c.id,
        EmailEvent.event_type == EmailEventType.SENT
    ).count()
    out.reply_count = db.query(Lead).filter(
        Lead.campaign_id == c.id,
        Lead.replied_at != None,
        Lead.is_deleted == False
    ).count()

    # Calculate progress percentage O(1) group by status
    max_step = db.query(func.max(SequenceStep.step_number)).join(Sequence).filter(Sequence.campaign_id == c.id).scalar() or 1
    
    counts = db.query(Lead.status, Lead.current_step, func.count(Lead.id)).filter(
        Lead.campaign_id == c.id, Lead.is_deleted == False
    ).group_by(Lead.status, Lead.current_step).all()

    total_leads = 0
    total_progress = 0.0
    for status, current_step, count in counts:
        total_leads += count
        if status == LeadStatus.NEW:
            lead_prog = 0.0
        elif status in (LeadStatus.CONTACTED, LeadStatus.OUT_OF_OFFICE):
            lead_prog = min(current_step / max_step, 1.0)
        else:
            lead_prog = 1.0
        
        total_progress += lead_prog * count

    out.progress_percentage = round((total_progress / total_leads * 100), 1) if total_leads > 0 else 0.0
    return out


@router.get("/campaigns", response_model=List[CampaignOut])
def list_campaigns(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    campaigns = db.query(Campaign).filter(Campaign.owner_id == user.id).all()
    result = []
    for c in campaigns:
        out = CampaignOut.model_validate(c)
        _populate_campaign_metrics(db, c, out)
        result.append(out)
    return result


@router.post("/campaigns", response_model=CampaignOut, status_code=201)
def create_campaign(payload: CampaignCreate, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    c = Campaign(
        owner_id=user.id,
        name=payload.name,
        active_days=payload.active_days.model_dump() if payload.active_days else None,
        sending_window_start=payload.sending_window_start,
        sending_window_end=payload.sending_window_end,
        daily_new_leads=payload.daily_new_leads,
        followup_percentage=payload.followup_percentage,
        daily_email_limit=payload.daily_email_limit,
        timezone=payload.timezone,
    )
    db.add(c)
    db.flush()
    
    # Auto-create default Main Sequence (Variant A)
    default_seq = Sequence(
        campaign_id=c.id,
        name="Variant A",
        is_main_variant=True,
        variant_weight=100
    )
    db.add(default_seq)
    db.commit()
    db.refresh(c)
    return CampaignOut.model_validate(c)


@router.get("/campaigns/{campaign_id}", response_model=CampaignOut)
def get_campaign(campaign_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    c = _get_campaign_or_404(db, campaign_id, user.id)
    out = CampaignOut.model_validate(c)
    _populate_campaign_metrics(db, c, out)
    return out


@router.patch("/campaigns/{campaign_id}", response_model=CampaignOut)
def update_campaign(campaign_id: int, payload: CampaignUpdate, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    from app.models import CampaignStatus, CampaignChangeEvent
    import json
    
    c = _get_campaign_or_404(db, campaign_id, user.id)
    
    # Validation when making campaign ACTIVE
    if payload.status == CampaignStatus.ACTIVE:
        # 1. Check that we have at least one lead
        lead_count = db.query(Lead).filter(Lead.campaign_id == campaign_id, Lead.is_deleted == False).count()
        if lead_count == 0:
            raise HTTPException(400, "Cannot activate campaign: Please import leads first.")
            
        # 2. Check that we have at least one sequence step
        seqs = db.query(Sequence).filter(Sequence.campaign_id == campaign_id).all()
        has_steps = any(db.query(SequenceStep).filter(SequenceStep.sequence_id == s.id).count() > 0 for s in seqs)
        if not has_steps:
            raise HTTPException(400, "Cannot activate campaign: Please add at least one email sequence step first.")
            
        # 3. Check that we have at least one assigned email inbox
        inbox_count = db.query(CampaignEmailAccount).filter(
            CampaignEmailAccount.campaign_id == campaign_id,
            CampaignEmailAccount.is_active == True
        ).count()
        if inbox_count == 0:
            raise HTTPException(400, "Cannot activate campaign: Please assign at least one email inbox to this campaign first.")
            
    is_active = c.status == CampaignStatus.ACTIVE
    
    # Store old values
    old_values = {
        "daily_email_limit": c.daily_email_limit,
        "sending_window_start": c.sending_window_start,
        "sending_window_end": c.sending_window_end,
        "timezone": c.timezone,
        "active_days": json.dumps(c.active_days) if c.active_days else None
    }
    
    for field, value in payload.model_dump(exclude_none=True).items():
        if field == "active_days" and hasattr(value, "model_dump"):
            value = value.model_dump()
        setattr(c, field, value)

    # Log change events if campaign is active
    if is_active:
        for field in ["daily_email_limit", "sending_window_start", "sending_window_end", "timezone", "active_days"]:
            new_val = getattr(c, field)
            old_val = old_values[field]
            
            if field == "active_days":
                new_str = json.dumps(new_val) if new_val else None
                old_str = old_val
            else:
                new_str = str(new_val) if new_val is not None else None
                old_str = str(old_val) if old_val is not None else None
                
            if old_str != new_str:
                ctype = field
                if field in ("sending_window_start", "sending_window_end"):
                    ctype = "sending_window"
                    
                event = CampaignChangeEvent(
                    campaign_id=c.id,
                    change_type=ctype,
                    old_value=old_str,
                    new_value=new_str,
                    changed_by=user.email,
                    applied_at=None
                )
                db.add(event)
    else:
        # Handle settings changes that require rescheduling immediately for drafts/paused campaigns
        from app.services.campaign_engine import recalculate_campaign_schedule
        if any(f in payload.model_dump(exclude_none=True) for f in ["timezone", "sending_window_start", "sending_window_end", "active_days"]):
            recalculate_campaign_schedule(db, c.id)

    # Auto-schedule emails immediately if transitioning to ACTIVE
    if c.status == CampaignStatus.ACTIVE and not is_active:
        from app.services.campaign_engine import _schedule_campaign_emails
        _schedule_campaign_emails(db, c)

    # Cancel future scheduled emails if transitioning from ACTIVE to a non-active status (e.g., PAUSED)
    if is_active and c.status != CampaignStatus.ACTIVE:
        db.query(ScheduledEmail).filter(
            ScheduledEmail.campaign_id == c.id,
            ScheduledEmail.is_sent == False,
            ScheduledEmail.is_cancelled == False
        ).update({
            ScheduledEmail.is_cancelled: True,
            ScheduledEmail.cancel_reason: "campaign_paused"
        }, synchronize_session=False)

    db.commit()
    db.refresh(c)
    out = CampaignOut.model_validate(c)
    _populate_campaign_metrics(db, c, out)
    return out



@router.get("/campaigns/{campaign_id}/export", response_model=CampaignImportExport)
def export_campaign(campaign_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    c = _get_campaign_or_404(db, campaign_id, user.id)
    
    # Format settings
    settings_data = {
        "name": c.name,
        "active_days": c.active_days,
        "sending_window_start": c.sending_window_start,
        "sending_window_end": c.sending_window_end,
        "daily_new_leads": c.daily_new_leads,
        "followup_percentage": c.followup_percentage,
        "daily_email_limit": c.daily_email_limit,
        "timezone": c.timezone,
        "track_open_rate": c.track_open_rate,
        "track_reply_rate": c.track_reply_rate,
    }
    
    # Format sequences
    sequences_data = []
    for seq in c.sequences:
        steps_data = []
        for step in seq.steps:
            steps_data.append({
                "step_number": step.step_number,
                "delay_days_min": step.delay_days_min,
                "delay_days_max": step.delay_days_max,
                "subject": step.subject,
                "body": step.body,
                "is_plain_text": step.is_plain_text,
            })
        sequences_data.append({
            "name": seq.name,
            "is_main_variant": seq.is_main_variant,
            "variant_weight": seq.variant_weight,
            "steps": steps_data,
        })
        
    return {
        "settings": settings_data,
        "sequences": sequences_data,
    }


@router.post("/campaigns/import", response_model=CampaignOut, status_code=201)
def import_campaign(payload: CampaignImportExport, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    # 1. Create Campaign
    c = Campaign(
        owner_id=user.id,
        name=payload.settings.name,
        active_days=payload.settings.active_days.model_dump(),
        sending_window_start=payload.settings.sending_window_start,
        sending_window_end=payload.settings.sending_window_end,
        daily_new_leads=payload.settings.daily_new_leads,
        followup_percentage=payload.settings.followup_percentage,
        daily_email_limit=payload.settings.daily_email_limit,
        timezone=payload.settings.timezone,
        track_open_rate=payload.settings.track_open_rate,
        track_reply_rate=payload.settings.track_reply_rate,
    )
    db.add(c)
    db.flush()
    
    # 2. Create Sequences and SequenceSteps
    for seq_in in payload.sequences:
        seq = Sequence(
            campaign_id=c.id,
            name=seq_in.name,
            is_main_variant=seq_in.is_main_variant,
            variant_weight=seq_in.variant_weight,
        )
        db.add(seq)
        db.flush()
        
        for step_in in seq_in.steps:
            step = SequenceStep(
                sequence_id=seq.id,
                step_number=step_in.step_number,
                delay_days_min=step_in.delay_days_min,
                delay_days_max=step_in.delay_days_max,
                subject=step_in.subject,
                body=step_in.body,
                is_plain_text=step_in.is_plain_text,
            )
            db.add(step)
            
    db.commit()
    db.refresh(c)
    return CampaignOut.model_validate(c)


@router.delete("/campaigns/{campaign_id}", status_code=204)
def delete_campaign(campaign_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    from app.models import CampaignChangeEvent, Message, SequenceStep
    import os
    c = _get_campaign_or_404(db, campaign_id, user.id)
    
    # 1. Delete Scheduled Emails
    db.query(ScheduledEmail).filter(ScheduledEmail.campaign_id == campaign_id).delete(synchronize_session=False)
    
    # 2. Delete Email Events
    db.query(EmailEvent).filter(EmailEvent.campaign_id == campaign_id).delete(synchronize_session=False)
    
    # 3. Clean up and delete Attachments (with local files)
    atts = db.query(Attachment).filter(Attachment.campaign_id == campaign_id).all()
    for att in atts:
        try:
            if os.path.exists(att.file_path):
                os.remove(att.file_path)
        except Exception:
            pass
    db.query(Attachment).filter(Attachment.campaign_id == campaign_id).delete(synchronize_session=False)
    
    # 4. Delete Campaign Change Events
    db.query(CampaignChangeEvent).filter(CampaignChangeEvent.campaign_id == campaign_id).delete(synchronize_session=False)
    
    # 5. Delete Campaign Email Account mappings
    db.query(CampaignEmailAccount).filter(CampaignEmailAccount.campaign_id == campaign_id).delete(synchronize_session=False)
    
    # 6. Delete Messages and Conversations
    conv_ids = [r[0] for r in db.query(Conversation.id).filter(Conversation.campaign_id == campaign_id).all()]
    if conv_ids:
        db.query(Message).filter(Message.conversation_id.in_(conv_ids)).delete(synchronize_session=False)
        db.query(Conversation).filter(Conversation.id.in_(conv_ids)).delete(synchronize_session=False)
        
    # 7. Delete Leads
    db.query(Lead).filter(Lead.campaign_id == campaign_id).delete(synchronize_session=False)
    
    # 8. Delete Sequence Steps and Sequences
    seq_ids = [r[0] for r in db.query(Sequence.id).filter(Sequence.campaign_id == campaign_id).all()]
    if seq_ids:
        db.query(SequenceStep).filter(SequenceStep.sequence_id.in_(seq_ids)).delete(synchronize_session=False)
        db.query(Sequence).filter(Sequence.id.in_(seq_ids)).delete(synchronize_session=False)
        
    # 9. Delete Campaign itself
    db.delete(c)
    db.commit()


# ─── Leads ────────────────────────────────────────────────────────────────────

from pydantic import BaseModel

class BulkDeleteLeads(BaseModel):
    lead_ids: List[int]

@router.get("/campaigns/{campaign_id}/leads", response_model=List[LeadOut])
def list_leads(
    campaign_id: int,
    status: Optional[str] = None,
    search: Optional[str] = None,
    step: Optional[int] = None,
    company: Optional[str] = None,
    skip: int = 0,
    limit: int = 2500,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user)
):
    _get_campaign_or_404(db, campaign_id, user.id)
    q = db.query(Lead).filter(Lead.campaign_id == campaign_id, Lead.is_deleted == False)
    
    if status:
        statuses = [s.strip() for s in status.split(",") if s.strip()]
        if statuses:
            q = q.filter(Lead.status.in_(statuses))
            
    if step is not None:
        q = q.filter(Lead.current_step == step)
        
    if company:
        q = q.filter(Lead.company.ilike(f"%{company}%"))
        
    leads = q.all()
    
    if search:
        s_query = search.lower()
        filtered = []
        for l in leads:
            match = (
                (l.first_name and s_query in l.first_name.lower()) or
                (l.last_name and s_query in l.last_name.lower()) or
                (s_query in l.email.lower()) or
                (l.company and s_query in l.company.lower()) or
                (l.website and s_query in l.website.lower()) or
                any(s_query in str(v).lower() for v in (l.custom_fields or {}).values())
            )
            if match:
                filtered.append(l)
        leads = filtered
        
    return leads[skip : skip + limit]


@router.get("/campaigns/{campaign_id}/leads/export")
def export_leads(
    campaign_id: int,
    status: Optional[str] = None,
    search: Optional[str] = None,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user)
):
    from fastapi.responses import StreamingResponse
    import csv
    
    _get_campaign_or_404(db, campaign_id, user.id)
    
    q = db.query(Lead).filter(Lead.campaign_id == campaign_id, Lead.is_deleted == False)
    if status:
        statuses = [s.strip() for s in status.split(",") if s.strip()]
        if statuses:
            q = q.filter(Lead.status.in_(statuses))
    leads = q.all()
    
    if search:
        s_query = search.lower()
        filtered = []
        for l in leads:
            match = (
                (l.first_name and s_query in l.first_name.lower()) or
                (l.last_name and s_query in l.last_name.lower()) or
                (s_query in l.email.lower()) or
                (l.company and s_query in l.company.lower()) or
                (l.website and s_query in l.website.lower()) or
                any(s_query in str(v).lower() for v in (l.custom_fields or {}).values())
            )
            if match:
                filtered.append(l)
        leads = filtered

    custom_keys = set()
    for l in leads:
        if l.custom_fields:
            custom_keys.update(l.custom_fields.keys())
    custom_keys = sorted(list(custom_keys))
    
    headers = ["Email", "First Name", "Last Name", "Company", "Website", "Status", "Current Step"] + custom_keys
    
    def generate_csv_rows():
        output = io.StringIO()
        writer = csv.writer(output)
        writer.writerow(headers)
        yield output.getvalue()
        
        for l in leads:
            output = io.StringIO()
            writer = csv.writer(output)
            row = [
                l.email, l.first_name or "", l.last_name or "",
                l.company or "", l.website or "", l.status, l.current_step
            ]
            for k in custom_keys:
                row.append(l.custom_fields.get(k, "") if l.custom_fields else "")
            writer.writerow(row)
            yield output.getvalue()
            
    campaign = db.query(Campaign).get(campaign_id)
    safe_name = "".join(c for c in campaign.name if c.isalnum() or c in (" ", "_", "-")).strip().replace(" ", "_")
    filename = f"{safe_name}_leads.csv"
    
    return StreamingResponse(
        generate_csv_rows(),
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename={filename}"}
    )


@router.delete("/campaigns/{campaign_id}/leads", status_code=200)
def bulk_delete_leads(
    campaign_id: int,
    payload: BulkDeleteLeads,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user)
):
    _get_campaign_or_404(db, campaign_id, user.id)
    
    leads = db.query(Lead).filter(
        Lead.campaign_id == campaign_id,
        Lead.id.in_(payload.lead_ids),
        Lead.is_deleted == False
    ).all()
    
    count = 0
    from app.services.campaign_engine import cancel_pending_emails_for_lead
    for lead in leads:
        lead.is_deleted = True
        cancel_pending_emails_for_lead(db, lead.id, reason="bulk_deleted")
        count += 1
        
    db.commit()
    return {"message": f"Successfully soft-deleted {count} leads", "deleted_count": count}



@router.get("/campaigns/{campaign_id}/leads/fields")
def get_lead_fields(campaign_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """Return all unique field keys available across leads in this campaign."""
    _get_campaign_or_404(db, campaign_id, user.id)
    standard = ["first_name", "last_name", "email", "company", "website"]
    # Collect custom field keys from up to 50 leads
    leads = db.query(Lead).filter(Lead.campaign_id == campaign_id, Lead.is_deleted == False).limit(50).all()
    custom_keys = set()
    for lead in leads:
        if lead.custom_fields:
            custom_keys.update(lead.custom_fields.keys())
    all_fields = standard + sorted(custom_keys)
    return {"fields": all_fields}


@router.post("/campaigns/{campaign_id}/leads", response_model=LeadOut, status_code=201)
def add_lead(campaign_id: int, payload: LeadCreate, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    _get_campaign_or_404(db, campaign_id, user.id)
    # Dedup check
    existing = db.query(Lead).filter(
        Lead.campaign_id == campaign_id,
        Lead.email == payload.email.lower()
    ).first()
    if existing:
        raise HTTPException(409, "Lead with this email already exists in campaign")
    lead = Lead(campaign_id=campaign_id, **payload.model_dump())
    lead.email = lead.email.lower()
    db.add(lead)
    db.commit()
    db.refresh(lead)
    return lead


@router.post("/campaigns/{campaign_id}/leads/import", response_model=LeadImportResult)
async def import_leads_csv(
    campaign_id: int,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user)
):
    """
    Import leads from CSV. Required column: email
    Optional: first_name, last_name, company, website
    Any other columns become custom_fields.
    """
    _get_campaign_or_404(db, campaign_id, user.id)
    content = await file.read()
    filename = (file.filename or "").lower()

    df = None
    parse_error = None

    # 1. Try as Excel (.xlsx or .xls) if extension matches or as fallback
    if filename.endswith(".xlsx") or filename.endswith(".xls"):
        try:
            df = pd.read_excel(io.BytesIO(content))
        except Exception as e:
            parse_error = f"Excel parse failed: {e}"

    # 2. Try CSV with multiple encodings
    if df is None:
        for enc in ("utf-8-sig", "utf-8", "latin-1", "cp1252"):
            try:
                df = pd.read_csv(io.BytesIO(content), encoding=enc)
                parse_error = None
                break
            except UnicodeDecodeError:
                continue
            except Exception as e:
                parse_error = f"CSV parse failed: {e}"
                break

    # 3. Last resort: try as Excel even without extension
    if df is None:
        try:
            df = pd.read_excel(io.BytesIO(content))
            parse_error = None
        except Exception as e:
            parse_error = parse_error or f"Could not parse file: {e}"

    if df is None:
        raise HTTPException(400, parse_error or "Could not parse file as CSV or Excel")

    # Normalize column names: strip whitespace, lowercase
    df.columns = [str(c).strip().lower().replace(" ", "_") for c in df.columns]

    if "email" not in df.columns:
        raise HTTPException(400, f"No 'email' column found. Your columns are: {list(df.columns)}")

    standard_cols = {"first_name", "last_name", "email", "company", "website"}
    imported = duplicates = errors = 0

    for _, row in df.iterrows():
        try:
            email = str(row["email"]).strip().lower()
            if not email or "@" not in email:
                errors += 1
                continue

            custom = {
                col: str(row[col]) for col in df.columns
                if col not in standard_cols and pd.notna(row[col])
            }

            # Check duplicate
            existing_lead = db.query(Lead).filter(Lead.campaign_id == campaign_id, Lead.email == email).first()
            if existing_lead:
                if existing_lead.is_deleted:
                    # Reactivate soft-deleted lead
                    existing_lead.is_deleted = False
                    existing_lead.status = LeadStatus.NEW
                    existing_lead.current_step = 0
                    existing_lead.first_name = str(row.get("first_name", "")) or None
                    existing_lead.last_name = str(row.get("last_name", "")) or None
                    existing_lead.company = str(row.get("company", "")) or None
                    existing_lead.website = str(row.get("website", "")) or None
                    existing_lead.custom_fields = custom
                    db.add(existing_lead)
                    imported += 1
                else:
                    duplicates += 1
                continue

            lead = Lead(
                campaign_id=campaign_id,
                email=email,
                first_name=str(row.get("first_name", "")) or None,
                last_name=str(row.get("last_name", "")) or None,
                company=str(row.get("company", "")) or None,
                website=str(row.get("website", "")) or None,
                custom_fields=custom,
            )
            db.add(lead)
            imported += 1

        except Exception:
            errors += 1

    db.commit()
    
    # Schedule emails immediately if campaign is active
    from app.models import CampaignStatus
    campaign = db.query(Campaign).get(campaign_id)
    if campaign and campaign.status == CampaignStatus.ACTIVE:
        from app.services.campaign_engine import _schedule_campaign_emails
        _schedule_campaign_emails(db, campaign)
        db.commit()

    return LeadImportResult(imported=imported, duplicates=duplicates, errors=errors)


# ─── Email Accounts ───────────────────────────────────────────────────────────

@router.get("/email-accounts", response_model=List[EmailAccountOut])
def list_accounts(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    return db.query(EmailAccount).filter(EmailAccount.owner_id == user.id).all()


@router.post("/email-accounts", response_model=EmailAccountOut, status_code=201)
def add_account(payload: EmailAccountCreate, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    is_warming = payload.is_warming_up or False
    account = EmailAccount(
        owner_id=user.id,
        name=payload.name,
        email=payload.email,
        smtp_host=payload.smtp_host,
        smtp_port=payload.smtp_port,
        smtp_username=payload.smtp_username,
        smtp_password_encrypted=encrypt_password(payload.smtp_password),
        use_tls=payload.use_tls,
        imap_host=payload.imap_host,
        imap_port=payload.imap_port,
        imap_use_ssl=payload.imap_use_ssl,
        daily_limit=payload.daily_limit,
        is_warming_up=is_warming,
        health_status="WARMING" if is_warming else "HEALTHY",
        warmup_start_date=datetime.utcnow().strftime("%Y-%m-%d") if is_warming else None,
        warmup_day_number=1 if is_warming else 1,
    )
    db.add(account)
    db.commit()
    db.refresh(account)
    return account


@router.patch("/email-accounts/bulk")
def bulk_update_accounts(
    payload: EmailAccountsBulkUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user)
):
    accounts = db.query(EmailAccount).filter(
        EmailAccount.id.in_(payload.account_ids),
        EmailAccount.owner_id == user.id
    ).all()

    if not accounts:
        raise HTTPException(404, "No matching email accounts found")

    needs_reschedule = False
    updated_count = 0

    for account in accounts:
        account_changed = False
        
        if payload.daily_limit is not None and account.daily_limit != payload.daily_limit:
            account.daily_limit = payload.daily_limit
            account_changed = True
            
        if payload.is_active is not None and account.is_active != payload.is_active:
            account.is_active = payload.is_active
            account_changed = True
            
        if payload.is_warming_up is not None and account.is_warming_up != payload.is_warming_up:
            account.is_warming_up = payload.is_warming_up
            account_changed = True
            if payload.is_warming_up:
                account.health_status = "WARMING"
                if not account.warmup_start_date:
                    account.warmup_start_date = datetime.utcnow().strftime("%Y-%m-%d")
                    account.warmup_day_number = 1
            else:
                account.health_status = "HEALTHY"

        if account_changed:
            needs_reschedule = True
            updated_count += 1

    if updated_count > 0:
        db.commit()

        if needs_reschedule:
            from app.models import CampaignEmailAccount, Campaign, CampaignStatus
            from app.services.campaign_engine import recalculate_campaign_schedule
            
            assignments = db.query(CampaignEmailAccount).filter(
                CampaignEmailAccount.email_account_id.in_(payload.account_ids),
                CampaignEmailAccount.is_active == True
            ).all()
            
            campaign_ids = {a.campaign_id for a in assignments}
            
            for cid in campaign_ids:
                campaign = db.query(Campaign).get(cid)
                if campaign and campaign.status == CampaignStatus.ACTIVE:
                    try:
                        recalculate_campaign_schedule(db, campaign.id)
                    except Exception:
                        pass

    return {"message": f"Successfully updated {updated_count} email accounts", "updated_count": updated_count}


@router.patch("/email-accounts/{account_id}", response_model=EmailAccountOut)
def update_account(
    account_id: int,
    payload: EmailAccountUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user)
):
    account = db.query(EmailAccount).filter(
        EmailAccount.id == account_id, EmailAccount.owner_id == user.id
    ).first()
    if not account:
        raise HTTPException(404, "Email account not found")
        
    needs_reschedule = False
    for field, value in payload.model_dump(exclude_none=True).items():
        if field in ("is_active", "daily_limit", "is_warming_up", "warmup_start_date"):
            if getattr(account, field) != value:
                needs_reschedule = True
 
        if field == "smtp_password":
            account.smtp_password_encrypted = encrypt_password(value)
        elif field == "is_warming_up":
            account.is_warming_up = value
            if value:
                account.health_status = "WARMING"
                if not account.warmup_start_date:
                    account.warmup_start_date = datetime.utcnow().strftime("%Y-%m-%d")
                    account.warmup_day_number = 1
            else:
                # If warm up is turned off, reset health_status to HEALTHY
                account.health_status = "HEALTHY"
        else:
            setattr(account, field, value)
            
    db.commit()
    db.refresh(account)
 
    if needs_reschedule:
        from app.models import CampaignEmailAccount, Campaign, CampaignStatus
        from app.services.campaign_engine import recalculate_campaign_schedule
        
        assignments = db.query(CampaignEmailAccount).filter(
            CampaignEmailAccount.email_account_id == account.id,
            CampaignEmailAccount.is_active == True
        ).all()
        
        for assignment in assignments:
            campaign = db.query(Campaign).get(assignment.campaign_id)
            if campaign and campaign.status == CampaignStatus.ACTIVE:
                try:
                    recalculate_campaign_schedule(db, campaign.id)
                except Exception as e:
                    pass
 
    return account


@router.delete("/email-accounts/{account_id}", status_code=204)
def delete_account(account_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    account = db.query(EmailAccount).filter(
        EmailAccount.id == account_id, EmailAccount.owner_id == user.id
    ).first()
    if not account:
        raise HTTPException(404, "Account not found")
        
    from app.models import CampaignEmailAccount, ScheduledEmail, EmailEvent, Campaign, CampaignStatus
    from app.services.campaign_engine import recalculate_campaign_schedule
    
    # 1. Find assigned campaigns
    assignments = db.query(CampaignEmailAccount).filter(
        CampaignEmailAccount.email_account_id == account.id
    ).all()
    campaign_ids = [a.campaign_id for a in assignments]
    
    # 2. Delete campaign assignments
    db.query(CampaignEmailAccount).filter(
        CampaignEmailAccount.email_account_id == account.id
    ).delete()
    
    # 3. Nullify references in events and queues to avoid ForeignKey constraints
    db.query(ScheduledEmail).filter(ScheduledEmail.email_account_id == account.id).update(
        {ScheduledEmail.email_account_id: None}, synchronize_session=False
    )
    db.query(EmailEvent).filter(EmailEvent.email_account_id == account.id).update(
        {EmailEvent.email_account_id: None}, synchronize_session=False
    )
    
    # 4. Delete the email account
    db.delete(account)
    db.commit()
    
    # 5. Reschedule active campaigns that were using this account
    for cid in campaign_ids:
        campaign = db.query(Campaign).get(cid)
        if campaign and campaign.status == CampaignStatus.ACTIVE:
            try:
                recalculate_campaign_schedule(db, campaign.id)
            except Exception as e:
                pass



@router.get("/campaigns/{campaign_id}/email-accounts")
def get_campaign_accounts(
    campaign_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Get all email accounts assigned to a campaign with health info."""
    _get_campaign_or_404(db, campaign_id, user.id)
    assignments = db.query(CampaignEmailAccount).filter(
        CampaignEmailAccount.campaign_id == campaign_id,
        CampaignEmailAccount.is_active == True,
    ).all()
    result = []
    for cea in assignments:
        acct = cea.email_account
        sends = max(acct.sends_this_week or 1, 1)
        bounce_rate = round((acct.bounces_this_week or 0) / sends * 100, 1)
        result.append({
            "assignment_id": cea.id,
            "account_id": acct.id,
            "name": acct.name,
            "email": acct.email,
            "daily_limit": acct.daily_limit,
            "emails_sent_today": acct.emails_sent_today,
            "health_status": acct.health_status or "HEALTHY",
            "is_warming_up": acct.is_warming_up or False,
            "warmup_day": acct.warmup_day_number or 1,
            "bounce_rate": bounce_rate,
            "sends_this_week": acct.sends_this_week or 0,
            "assigned_at": cea.assigned_at,
        })
    return result


@router.post("/campaigns/{campaign_id}/email-accounts/{account_id}")
def assign_account_to_campaign(
    campaign_id: int,
    account_id: int,
    force: bool = False,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """
    Assign an email account to a campaign.
    Enforces: one active campaign per account at a time.
    Pass ?force=true to override and move account from another campaign.
    """
    _get_campaign_or_404(db, campaign_id, user.id)

    # Verify account belongs to this user
    account = db.query(EmailAccount).filter(
        EmailAccount.id == account_id,
        EmailAccount.owner_id == user.id,
    ).first()
    if not account:
        raise HTTPException(404, "Email account not found")

    # Check if already assigned to THIS campaign
    existing_same = db.query(CampaignEmailAccount).filter(
        CampaignEmailAccount.campaign_id == campaign_id,
        CampaignEmailAccount.email_account_id == account_id,
        CampaignEmailAccount.is_active == True,
    ).first()
    if existing_same:
        raise HTTPException(409, "Account already assigned to this campaign")

    # Check if assigned to a DIFFERENT active campaign
    existing_other = db.query(CampaignEmailAccount).filter(
        CampaignEmailAccount.email_account_id == account_id,
        CampaignEmailAccount.is_active == True,
        CampaignEmailAccount.campaign_id != campaign_id,
    ).first()

    if existing_other and not force:
        # Return conflict info so frontend can ask user to confirm
        other_campaign = db.query(Campaign).get(existing_other.campaign_id)
        raise HTTPException(409, f"CONFLICT:{other_campaign.name}:{existing_other.campaign_id}")

    if existing_other and force:
        # Remove from the other campaign first
        existing_other.is_active = False
        db.flush()

    cea = CampaignEmailAccount(
        campaign_id=campaign_id,
        email_account_id=account_id,
        is_active=True,
    )
    db.add(cea)
    db.commit()
    return {"message": "Account assigned to campaign", "account_email": account.email}


@router.delete("/campaigns/{campaign_id}/email-accounts/{account_id}")
def unassign_account_from_campaign(
    campaign_id: int,
    account_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Remove an email account from a campaign."""
    _get_campaign_or_404(db, campaign_id, user.id)
    cea = db.query(CampaignEmailAccount).filter(
        CampaignEmailAccount.campaign_id == campaign_id,
        CampaignEmailAccount.email_account_id == account_id,
        CampaignEmailAccount.is_active == True,
    ).first()
    if not cea:
        raise HTTPException(404, "Assignment not found")
    cea.is_active = False
    db.commit()
    return {"message": "Account removed from campaign"}


@router.get("/email-accounts/availability")
def get_accounts_availability(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """
    Returns all email accounts with their current campaign assignment status.
    Used to show which accounts are free vs locked to a campaign.
    """
    accounts = db.query(EmailAccount).filter(
        EmailAccount.owner_id == user.id,
        EmailAccount.is_active == True,
    ).all()

    result = []
    for acct in accounts:
        # Find active assignment
        active_cea = db.query(CampaignEmailAccount).filter(
            CampaignEmailAccount.email_account_id == acct.id,
            CampaignEmailAccount.is_active == True,
        ).first()

        assigned_campaign = None
        if active_cea:
            camp = db.query(Campaign).get(active_cea.campaign_id)
            if camp:
                assigned_campaign = {"id": camp.id, "name": camp.name, "status": camp.status}

        sends = max(acct.sends_this_week or 1, 1)
        bounce_rate = round((acct.bounces_this_week or 0) / sends * 100, 1)

        result.append({
            "id": acct.id,
            "name": acct.name,
            "email": acct.email,
            "daily_limit": acct.daily_limit,
            "emails_sent_today": acct.emails_sent_today or 0,
            "health_status": acct.health_status or "HEALTHY",
            "is_warming_up": acct.is_warming_up or False,
            "warmup_day": acct.warmup_day_number or 1,
            "bounce_rate": bounce_rate,
            "sends_this_week": acct.sends_this_week or 0,
            "assigned_campaign": assigned_campaign,
            "is_free": assigned_campaign is None,
        })
    return result

# ─── Sequences ────────────────────────────────────────────────────────────────

@router.get("/campaigns/{campaign_id}/sequences", response_model=List[SequenceOut])
def list_sequences(campaign_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    _get_campaign_or_404(db, campaign_id, user.id)
    return db.query(Sequence).filter(Sequence.campaign_id == campaign_id).all()


@router.post("/campaigns/{campaign_id}/sequences", response_model=SequenceOut, status_code=201)
def create_sequence(campaign_id: int, payload: SequenceCreate, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    _get_campaign_or_404(db, campaign_id, user.id)
    is_main = db.query(Sequence).filter(Sequence.campaign_id == campaign_id).count() == 0
    seq = Sequence(
        campaign_id=campaign_id,
        name=payload.name,
        is_main_variant=payload.is_main_variant if payload.is_main_variant is not None else is_main,
        variant_weight=payload.variant_weight if payload.variant_weight is not None else 100
    )
    db.add(seq)
    db.flush()
    for step_data in payload.steps:
        step = SequenceStep(sequence_id=seq.id, **step_data.model_dump())
        db.add(step)
    db.commit()
    db.refresh(seq)
    return seq


@router.put("/campaigns/{campaign_id}/sequences/{seq_id}", response_model=SequenceOut)
def update_sequence(
    campaign_id: int, seq_id: int, payload: SequenceCreate,
    db: Session = Depends(get_db), user: User = Depends(get_current_user)
):
    _get_campaign_or_404(db, campaign_id, user.id)
    seq = db.query(Sequence).filter(Sequence.id == seq_id, Sequence.campaign_id == campaign_id).first()
    if not seq:
        raise HTTPException(404, "Sequence not found")
    # Delete existing steps and recreate
    for step in seq.steps:
        db.delete(step)
    seq.name = payload.name
    if payload.variant_weight is not None:
        seq.variant_weight = payload.variant_weight
    if payload.is_main_variant is not None:
        seq.is_main_variant = payload.is_main_variant
    db.flush()
    for step_data in payload.steps:
        step = SequenceStep(sequence_id=seq.id, **step_data.model_dump())
        db.add(step)
    db.commit()
    db.refresh(seq)
    return seq


@router.delete("/campaigns/{campaign_id}/sequences/{seq_id}", status_code=204)
def delete_sequence(campaign_id: int, seq_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    _get_campaign_or_404(db, campaign_id, user.id)
    seq = db.query(Sequence).filter(Sequence.id == seq_id, Sequence.campaign_id == campaign_id).first()
    if not seq:
        raise HTTPException(404, "Sequence not found")
    if seq.is_main_variant:
        raise HTTPException(400, "Cannot delete the main sequence variant")
    
    # Reassign leads pointing to this sequence to the main sequence
    main_seq = db.query(Sequence).filter(Sequence.campaign_id == campaign_id, Sequence.is_main_variant == True).first()
    if main_seq:
        db.query(Lead).filter(Lead.sequence_id == seq.id).update({Lead.sequence_id: main_seq.id})
    
    # Delete sequence steps and sequence
    for step in seq.steps:
        db.delete(step)
    db.delete(seq)
    db.commit()
    return None


# ─── Master Inbox ─────────────────────────────────────────────────────────────

@router.get("/inbox", response_model=List[ConversationOut])
def get_inbox(
    skip: int = 0,
    limit: int = 1000,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user)
):
    """Get all conversations across all campaigns"""
    convs = db.query(Conversation).join(
        Campaign, Conversation.campaign_id == Campaign.id
    ).filter(
        Campaign.owner_id == user.id
    ).order_by(
        Conversation.last_message_at.desc()
    ).offset(skip).limit(limit).all()
    return convs


@router.get("/inbox/{conversation_id}", response_model=ConversationOut)
def get_conversation(conversation_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    conv = db.query(Conversation).get(conversation_id)
    if not conv:
        raise HTTPException(404, "Conversation not found")
    # Mark as read
    conv.has_unread = False
    db.commit()
    return conv


class InboxReplyPayload(BaseModel):
    body: str


@router.post("/inbox/{conversation_id}/reply")
def reply_to_conversation(
    conversation_id: int,
    payload: InboxReplyPayload,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Send an outbound reply to a conversation."""
    from app.services.email_sender import send_reply_via_smtp
    
    # Check if conversation exists and belongs to the current user's campaign
    conv = db.query(Conversation).join(
        Campaign, Conversation.campaign_id == Campaign.id
    ).filter(
        Conversation.id == conversation_id,
        Campaign.owner_id == user.id
    ).first()
    
    if not conv:
        raise HTTPException(404, "Conversation not found")
        
    try:
        success = send_reply_via_smtp(db, conversation_id, payload.body)
        if not success:
            raise HTTPException(500, "Failed to send email reply via SMTP")
        return {"status": "success", "message": "Reply sent successfully"}
    except Exception as e:
        raise HTTPException(400, str(e))


# ─── Analytics ────────────────────────────────────────────────────────────────

@router.get("/campaigns/{campaign_id}/stats", response_model=CampaignStats)
def campaign_stats(campaign_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    _get_campaign_or_404(db, campaign_id, user.id)

    total = db.query(Lead).filter(Lead.campaign_id == campaign_id, Lead.is_deleted == False).count()
    contacted = db.query(Lead).filter(Lead.campaign_id == campaign_id, Lead.contacted_at != None, Lead.is_deleted == False).count()
    replied = db.query(Lead).filter(Lead.campaign_id == campaign_id, Lead.replied_at != None, Lead.is_deleted == False).count()
    bounced = db.query(Lead).filter(Lead.campaign_id == campaign_id, Lead.status == LeadStatus.BOUNCED, Lead.is_deleted == False).count()
    sent = db.query(EmailEvent).filter(
        EmailEvent.campaign_id == campaign_id,
        EmailEvent.event_type == EmailEventType.SENT
    ).count()
    pending = db.query(ScheduledEmail).filter(
        ScheduledEmail.campaign_id == campaign_id,
        ScheduledEmail.is_sent == False,
        ScheduledEmail.is_cancelled == False,
    ).count()
    reply_rate = round((replied / max(contacted, 1)) * 100, 1)

    return CampaignStats(
        total_leads=total,
        contacted=contacted,
        replied=replied,
        bounced=bounced,
        reply_rate=reply_rate,
        emails_sent=sent,
        pending_emails=pending,
    )


# ─── Activity Feed ────────────────────────────────────────────────────────────

@router.get("/campaigns/{campaign_id}/activity", response_model=ActivityFeedOut)
def get_campaign_activity(
    campaign_id: int,
    skip: int = 0,
    limit: int = 50,
    event_type: Optional[str] = None,   # filter: SENT, SCHEDULED, FAILED, CANCELLED, REPLIED
    account_id: Optional[int] = None,   # filter by email account
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """
    Unified activity feed for a campaign.
    Merges: EmailEvents (sent/failed/replied/bounced) + ScheduledEmails (scheduled/cancelled)
    Sorted by most recent first.
    """
    from app.models import SequenceStep, EmailAccount as EmailAccountModel
    _get_campaign_or_404(db, campaign_id, user.id)

    results = []

    # ── Sent / Failed / Replied / Bounced from EmailEvent ───────────────────
    if not event_type or event_type in ("SENT", "FAILED", "REPLIED", "BOUNCED", "CLICKED", "OPENED"):
        eq = db.query(EmailEvent).filter(EmailEvent.campaign_id == campaign_id)
        if event_type:
            eq = eq.filter(EmailEvent.event_type == event_type)
        if account_id:
            eq = eq.filter(EmailEvent.email_account_id == account_id)
        events = eq.order_by(EmailEvent.timestamp.desc()).all()

        for ev in events:
            lead = db.query(Lead).get(ev.lead_id)
            step = db.query(SequenceStep).get(ev.sequence_step_id) if ev.sequence_step_id else None
            acct = db.query(EmailAccountModel).get(ev.email_account_id) if ev.email_account_id else None
            results.append(ActivityEventOut(
                id=ev.id,
                event_type=ev.event_type,
                lead_email=lead.email if lead else "unknown",
                lead_name=f"{lead.first_name or ''} {lead.last_name or ''}".strip() if lead else None,
                sequence_step=step.step_number if step else None,
                email_account=acct.email if acct else None,
                scheduled_for=None,
                sent_at=ev.timestamp,
                timestamp=ev.timestamp,
                cancel_reason=None,
                error_message=ev.error_message,
                is_sent=True,
                is_cancelled=False,
            ))

    # ── Scheduled / Cancelled from ScheduledEmail ────────────────────────────
    if not event_type or event_type in ("SCHEDULED", "CANCELLED"):
        sq = db.query(ScheduledEmail).filter(ScheduledEmail.campaign_id == campaign_id)
        if event_type == "SCHEDULED":
            sq = sq.filter(ScheduledEmail.is_sent == False, ScheduledEmail.is_cancelled == False)
        elif event_type == "CANCELLED":
            sq = sq.filter(ScheduledEmail.is_cancelled == True)
        if account_id:
            sq = sq.filter(ScheduledEmail.email_account_id == account_id)
        scheduled = sq.order_by(ScheduledEmail.scheduled_for.desc()).all()

        for se in scheduled:
            lead = db.query(Lead).get(se.lead_id)
            step = db.query(SequenceStep).get(se.sequence_step_id) if se.sequence_step_id else None
            acct = db.query(EmailAccountModel).get(se.email_account_id) if se.email_account_id else None

            if se.is_cancelled:
                etype = "CANCELLED"
                ts = se.created_at
            elif se.is_sent:
                continue  # Already shown in EmailEvent above
            else:
                etype = "SCHEDULED"
                ts = se.scheduled_for

            results.append(ActivityEventOut(
                id=se.id,
                event_type=etype,
                lead_email=lead.email if lead else "unknown",
                lead_name=f"{lead.first_name or ''} {lead.last_name or ''}".strip() if lead else None,
                sequence_step=step.step_number if step else None,
                email_account=acct.email if acct else None,
                scheduled_for=se.scheduled_for,
                sent_at=se.sent_at,
                timestamp=ts,
                cancel_reason=se.cancel_reason,
                error_message=None,
                is_sent=se.is_sent,
                is_cancelled=se.is_cancelled,
            ))

    # Sort all events newest first, paginate
    results.sort(key=lambda x: x.timestamp, reverse=True)
    total = len(results)
    paginated = results[skip: skip + limit]

    return ActivityFeedOut(
        events=paginated,
        total=total,
        has_more=(skip + limit) < total,
    )


@router.get("/campaigns/{campaign_id}/activity/summary")
def get_activity_summary(
    campaign_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Quick count summary per event type for the activity tab header."""
    _get_campaign_or_404(db, campaign_id, user.id)

    from app.models import EmailEventType

    summary = {}
    for etype in ["SENT", "FAILED", "REPLIED", "BOUNCED"]:
        summary[etype] = db.query(EmailEvent).filter(
            EmailEvent.campaign_id == campaign_id,
            EmailEvent.event_type == etype,
        ).count()

    summary["SCHEDULED"] = db.query(ScheduledEmail).filter(
        ScheduledEmail.campaign_id == campaign_id,
        ScheduledEmail.is_sent == False,
        ScheduledEmail.is_cancelled == False,
    ).count()

    summary["CANCELLED"] = db.query(ScheduledEmail).filter(
        ScheduledEmail.campaign_id == campaign_id,
        ScheduledEmail.is_cancelled == True,
    ).count()

    return summary

# ─── Analytics Dashboard ──────────────────────────────────────────────────────

@router.get("/campaigns/{campaign_id}/analytics")
def get_campaign_analytics(
    campaign_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """
    Full analytics breakdown for a campaign.
    Returns: overall stats + per-step breakdown + per-account breakdown
    """
    from app.models import (
        EmailEventType, SequenceStep, Sequence,
        EmailAccount as EmailAccountModel
    )
    _get_campaign_or_404(db, campaign_id, user.id)

    # ── Overall stats ────────────────────────────────────────────────────────
    total_leads     = db.query(Lead).filter(Lead.campaign_id == campaign_id, Lead.is_deleted == False).count()
    new_leads       = db.query(Lead).filter(Lead.campaign_id == campaign_id, Lead.status == LeadStatus.NEW, Lead.is_deleted == False).count()
    contacted       = db.query(Lead).filter(Lead.campaign_id == campaign_id, Lead.contacted_at != None, Lead.is_deleted == False).count()
    replied         = db.query(Lead).filter(Lead.campaign_id == campaign_id, Lead.replied_at != None, Lead.is_deleted == False).count()
    bounced         = db.query(Lead).filter(Lead.campaign_id == campaign_id, Lead.status == LeadStatus.BOUNCED, Lead.is_deleted == False).count()

    sent_count      = db.query(EmailEvent).filter(EmailEvent.campaign_id == campaign_id, EmailEvent.event_type == EmailEventType.SENT).count()
    failed_count    = db.query(EmailEvent).filter(EmailEvent.campaign_id == campaign_id, EmailEvent.event_type == EmailEventType.FAILED).count()
    opened_count    = db.query(EmailEvent).filter(EmailEvent.campaign_id == campaign_id, EmailEvent.event_type == EmailEventType.OPENED).count()
    clicked_count   = db.query(EmailEvent).filter(EmailEvent.campaign_id == campaign_id, EmailEvent.event_type == EmailEventType.CLICKED).count()
    replied_events  = db.query(EmailEvent).filter(EmailEvent.campaign_id == campaign_id, EmailEvent.event_type == EmailEventType.REPLIED).count()
    bounced_events  = db.query(EmailEvent).filter(EmailEvent.campaign_id == campaign_id, EmailEvent.event_type == EmailEventType.BOUNCED).count()

    scheduled_pending = db.query(ScheduledEmail).filter(
        ScheduledEmail.campaign_id == campaign_id,
        ScheduledEmail.is_sent == False,
        ScheduledEmail.is_cancelled == False,
    ).count()

    scheduled_cancelled = db.query(ScheduledEmail).filter(
        ScheduledEmail.campaign_id == campaign_id,
        ScheduledEmail.is_cancelled == True,
    ).count()

    # Rates (safe division)
    def rate(num, den):
        return round((num / den * 100), 1) if den > 0 else 0.0

    overall = {
        "total_leads":          total_leads,
        "new":                  new_leads,
        "contacted":            contacted,
        "replied":              replied,
        "bounced":              bounced,
        "emails_sent":          sent_count,
        "emails_failed":        failed_count,
        "emails_opened":        opened_count,
        "emails_clicked":       clicked_count,
        "emails_scheduled":     scheduled_pending,
        "emails_cancelled":     scheduled_cancelled,
        "open_rate":            rate(opened_count, sent_count),
        "click_rate":           rate(clicked_count, sent_count),
        "reply_rate":           rate(replied, max(contacted, 1)),
        "bounce_rate":          rate(bounced_events, sent_count),
        "delivery_rate":        rate(sent_count, sent_count + failed_count),
    }

    # ── Per-step breakdown ───────────────────────────────────────────────────
    sequence = db.query(Sequence).filter(Sequence.campaign_id == campaign_id).first()
    per_step = []
    if sequence:
        steps = sorted(sequence.steps, key=lambda s: s.step_number)
        for step in steps:
            step_sent    = db.query(EmailEvent).filter(EmailEvent.campaign_id == campaign_id, EmailEvent.sequence_step_id == step.id, EmailEvent.event_type == EmailEventType.SENT).count()
            step_failed  = db.query(EmailEvent).filter(EmailEvent.campaign_id == campaign_id, EmailEvent.sequence_step_id == step.id, EmailEvent.event_type == EmailEventType.FAILED).count()
            step_opened  = db.query(EmailEvent).filter(EmailEvent.campaign_id == campaign_id, EmailEvent.sequence_step_id == step.id, EmailEvent.event_type == EmailEventType.OPENED).count()
            step_clicked = db.query(EmailEvent).filter(EmailEvent.campaign_id == campaign_id, EmailEvent.sequence_step_id == step.id, EmailEvent.event_type == EmailEventType.CLICKED).count()
            step_replied = db.query(EmailEvent).filter(EmailEvent.campaign_id == campaign_id, EmailEvent.sequence_step_id == step.id, EmailEvent.event_type == EmailEventType.REPLIED).count()
            step_bounced = db.query(EmailEvent).filter(EmailEvent.campaign_id == campaign_id, EmailEvent.sequence_step_id == step.id, EmailEvent.event_type == EmailEventType.BOUNCED).count()
            step_scheduled = db.query(ScheduledEmail).filter(ScheduledEmail.campaign_id == campaign_id, ScheduledEmail.sequence_step_id == step.id, ScheduledEmail.is_sent == False, ScheduledEmail.is_cancelled == False).count()

            per_step.append({
                "step_number":  step.step_number,
                "subject":      step.subject[:60] + "..." if len(step.subject) > 60 else step.subject,
                "delay":        f"{step.delay_days_min}–{step.delay_days_max}d" if step.step_number > 1 else "Immediate",
                "sent":         step_sent,
                "failed":       step_failed,
                "opened":       step_opened,
                "clicked":      step_clicked,
                "replied":      step_replied,
                "bounced":      step_bounced,
                "scheduled":    step_scheduled,
                "open_rate":    rate(step_opened, step_sent),
                "reply_rate":   rate(step_replied, step_sent),
                "bounce_rate":  rate(step_bounced, step_sent),
            })

    # ── Per-account breakdown ────────────────────────────────────────────────
    per_account = []
    assignments = db.query(CampaignEmailAccount).filter(
        CampaignEmailAccount.campaign_id == campaign_id,
    ).all()

    for cea in assignments:
        acct = cea.email_account
        acct_sent    = db.query(EmailEvent).filter(EmailEvent.campaign_id == campaign_id, EmailEvent.email_account_id == acct.id, EmailEvent.event_type == EmailEventType.SENT).count()
        acct_failed  = db.query(EmailEvent).filter(EmailEvent.campaign_id == campaign_id, EmailEvent.email_account_id == acct.id, EmailEvent.event_type == EmailEventType.FAILED).count()
        acct_replied = db.query(EmailEvent).filter(EmailEvent.campaign_id == campaign_id, EmailEvent.email_account_id == acct.id, EmailEvent.event_type == EmailEventType.REPLIED).count()
        acct_bounced = db.query(EmailEvent).filter(EmailEvent.campaign_id == campaign_id, EmailEvent.email_account_id == acct.id, EmailEvent.event_type == EmailEventType.BOUNCED).count()

        per_account.append({
            "account_id":    acct.id,
            "email":         acct.email,
            "name":          acct.name,
            "health_status": acct.health_status or "HEALTHY",
            "sent":          acct_sent,
            "failed":        acct_failed,
            "replied":       acct_replied,
            "bounced":       acct_bounced,
            "reply_rate":    rate(acct_replied, acct_sent),
            "bounce_rate":   rate(acct_bounced, acct_sent),
            "daily_limit":   acct.daily_limit,
            "sent_today":    acct.emails_sent_today or 0,
        })

    return {
        "overall":     overall,
        "per_step":    per_step,
        "per_account": per_account,
    }


# ─── Lead Status Management ───────────────────────────────────────────────────

@router.patch("/campaigns/{campaign_id}/leads/{lead_id}/status")
def update_lead_status(
    campaign_id: int,
    lead_id: int,
    payload: dict,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """
    Manually update a lead's status.
    payload: { "status": "INTERESTED", "note": "optional note" }
    """
    _get_campaign_or_404(db, campaign_id, user.id)
    lead = db.query(Lead).filter(
        Lead.id == lead_id,
        Lead.campaign_id == campaign_id,
    ).first()
    if not lead:
        raise HTTPException(404, "Lead not found")

    new_status = payload.get("status")
    if not new_status:
        raise HTTPException(400, "status is required")

    # Validate status value
    valid = [s.value for s in LeadStatus]
    if new_status not in valid:
        raise HTTPException(400, f"Invalid status. Must be one of: {valid}")

    old_status = lead.status
    lead.status = new_status
    lead.status_changed_at = datetime.utcnow()
    lead.status_changed_by = "user"
    lead.status_note = payload.get("note", f"Manually set to {new_status}")

    # Auto-cancel follow-ups if status changes to any non-active state
    if new_status not in (LeadStatus.NEW, LeadStatus.CONTACTED, LeadStatus.OUT_OF_OFFICE):
        from app.services.campaign_engine import cancel_pending_emails_for_lead
        cancel_pending_emails_for_lead(db, lead.id, reason=f"manual_{new_status.lower()}")

    db.commit()
    return {
        "id": lead.id,
        "status": lead.status,
        "old_status": old_status,
        "status_note": lead.status_note,
        "status_changed_at": lead.status_changed_at,
    }


@router.delete("/campaigns/{campaign_id}/leads/{lead_id}", status_code=204)
def delete_lead(campaign_id: int, lead_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """Delete a lead from a campaign (soft delete)."""
    _get_campaign_or_404(db, campaign_id, user.id)
    lead = db.query(Lead).filter(Lead.id == lead_id, Lead.campaign_id == campaign_id, Lead.is_deleted == False).first()
    if not lead:
        raise HTTPException(404, "Lead not found")
    
    lead.is_deleted = True
    from app.services.campaign_engine import cancel_pending_emails_for_lead
    cancel_pending_emails_for_lead(db, lead.id, reason="deleted")
    db.commit()
    return None



# ─── Attachments ────────────────────────────────────────────────────────────────

@router.post("/campaigns/{campaign_id}/attachments", status_code=201)
async def upload_attachment(
    campaign_id: int,
    sequence_step_id: Optional[int] = None,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Upload a file attachment for campaign sequence steps."""
    from app.models import Attachment
    import os
    import uuid

    _get_campaign_or_404(db, campaign_id, user.id)

    # Create upload directory
    upload_dir = f"/tmp/coldreach-attachments/{campaign_id}"
    os.makedirs(upload_dir, exist_ok=True)

    # Generate unique filename
    ext = file.filename.split(".")[-1] if "." in file.filename else ""
    unique_name = f"{uuid.uuid4()}.{ext}" if ext else str(uuid.uuid4())
    file_path = f"{upload_dir}/{unique_name}"

    # Save file
    content = await file.read()
    with open(file_path, "wb") as f:
        f.write(content)

    # Save to database
    att = Attachment(
        campaign_id=campaign_id,
        sequence_step_id=sequence_step_id,
        filename=file.filename,
        file_path=file_path,
        file_size=len(content),
        mime_type=file.content_type or "application/octet-stream",
    )
    db.add(att)
    db.commit()
    db.refresh(att)

    return {"id": att.id, "filename": att.filename, "size": att.file_size}


@router.get("/campaigns/{campaign_id}/attachments")
def list_attachments(campaign_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """List all attachments for a campaign."""
    from app.models import Attachment
    _get_campaign_or_404(db, campaign_id, user.id)
    return db.query(Attachment).filter(Attachment.campaign_id == campaign_id).all()


@router.delete("/campaigns/{campaign_id}/attachments/{attachment_id}", status_code=204)
def delete_attachment(campaign_id: int, attachment_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """Delete an attachment."""
    from app.models import Attachment
    import os

    _get_campaign_or_404(db, campaign_id, user.id)
    att = db.query(Attachment).filter(
        Attachment.id == attachment_id,
        Attachment.campaign_id == campaign_id,
    ).first()
    if not att:
        raise HTTPException(404, "Attachment not found")

    # Delete file
    try:
        if os.path.exists(att.file_path):
            os.remove(att.file_path)
    except:
        pass

    db.delete(att)
    db.commit()


# ─── Sequence Variants ──────────────────────────────────────────────────────────


@router.patch("/campaigns/{campaign_id}/sequences/{seq_id}/set-active")
def set_active_sequence(
    campaign_id: int,
    seq_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Set a sequence as the main/active variant."""
    _get_campaign_or_404(db, campaign_id, user.id)
    seq = db.query(Sequence).filter(
        Sequence.id == seq_id,
        Sequence.campaign_id == campaign_id,
    ).first()
    if not seq:
        raise HTTPException(404, "Sequence not found")

    # Remove main flag from current main
    db.query(Sequence).filter(
        Sequence.campaign_id == campaign_id,
        Sequence.is_main_variant == True,
    ).update({Sequence.is_main_variant: False})

    seq.is_main_variant = True
    db.commit()
    return {"message": "Sequence set as active variant"}


# ─── Email Connection Test ──────────────────────────────────────────────────────

@router.post("/email-accounts/test-connection")
def test_email_connection(
    payload: EmailAccountCreate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Test SMTP connection without saving account."""
    import smtplib
    from app.core.encryption import decrypt_password

    try:
        server = smtplib.SMTP(payload.smtp_host, payload.smtp_port, timeout=10)
        if payload.use_tls:
            server.starttls()
        server.login(payload.smtp_username, payload.smtp_password)
        server.quit()
        return {"message": "Connection successful"}
    except Exception as e:
        raise HTTPException(400, f"Connection failed: {str(e)}")


@router.get("/campaigns/{campaign_id}/leads/by-status")
def leads_by_status(
    campaign_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Count of leads per status for the kanban overview."""
    _get_campaign_or_404(db, campaign_id, user.id)
    result = {}
    for status in LeadStatus:
        count = db.query(Lead).filter(
            Lead.campaign_id == campaign_id,
            Lead.status == status,
            Lead.is_deleted == False,
        ).count()
        if count > 0:
            result[status.value] = count
    return result


@router.get("/track/open/{event_id}")
def track_open(event_id: int, db: Session = Depends(get_db)):
    """Record an email open event (from 1x1 image pixel)."""
    from app.models import EmailEvent, EmailEventType
    from datetime import datetime
    from fastapi.responses import Response

    event = db.query(EmailEvent).get(event_id)
    if event:
        # Check if already opened to avoid double counting
        existing_open = db.query(EmailEvent).filter(
            EmailEvent.lead_id == event.lead_id,
            EmailEvent.campaign_id == event.campaign_id,
            EmailEvent.sequence_step_id == event.sequence_step_id,
            EmailEvent.event_type == EmailEventType.OPENED
        ).first()

        if not existing_open:
            # Log opened event
            open_event = EmailEvent(
                lead_id=event.lead_id,
                campaign_id=event.campaign_id,
                email_account_id=event.email_account_id,
                sequence_step_id=event.sequence_step_id,
                event_type=EmailEventType.OPENED,
                timestamp=datetime.utcnow()
            )
            db.add(open_event)
            db.commit()
            
    # Return a 1x1 transparent GIF image
    transparent_gif = b'\x47\x49\x46\x38\x39\x61\x01\x00\x01\x00\x80\x00\x00\xff\xff\xff\x00\x00\x00\x21\xf9\x04\x01\x00\x00\x00\x00\x2c\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02\x44\x01\x00\x3b'
    return Response(content=transparent_gif, media_type="image/gif")


class SequencePatch(BaseModel):
    name: Optional[str] = None
    variant_weight: Optional[int] = None
    is_main_variant: Optional[bool] = None

@router.patch("/campaigns/{campaign_id}/sequences/{seq_id}", response_model=SequenceOut)
def patch_sequence(
    campaign_id: int,
    seq_id: int,
    payload: SequencePatch,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    _get_campaign_or_404(db, campaign_id, user.id)
    seq = db.query(Sequence).filter(Sequence.id == seq_id, Sequence.campaign_id == campaign_id).first()
    if not seq:
        raise HTTPException(404, "Sequence not found")
        
    if payload.name is not None:
        seq.name = payload.name
    if payload.variant_weight is not None:
        seq.variant_weight = payload.variant_weight
    if payload.is_main_variant is not None:
        seq.is_main_variant = payload.is_main_variant
        
    db.commit()
    db.refresh(seq)
    return seq


@router.get("/campaigns/{campaign_id}/analytics/variants")
def get_variant_analytics(
    campaign_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    from app.models import EmailEventType
    _get_campaign_or_404(db, campaign_id, user.id)
    
    variants = db.query(Sequence).filter(Sequence.campaign_id == campaign_id).all()
    result = []
    
    for seq in variants:
        leads_assigned = db.query(Lead).filter(
            Lead.campaign_id == campaign_id,
            Lead.sequence_id == seq.id,
            Lead.is_deleted == False
        ).count()
        
        step_ids = [step.id for step in seq.steps]
        
        if step_ids:
            emails_sent = db.query(EmailEvent).filter(
                EmailEvent.campaign_id == campaign_id,
                EmailEvent.sequence_step_id.in_(step_ids),
                EmailEvent.event_type == EmailEventType.SENT
            ).count()
            
            replies = db.query(EmailEvent).filter(
                EmailEvent.campaign_id == campaign_id,
                EmailEvent.sequence_step_id.in_(step_ids),
                EmailEvent.event_type == EmailEventType.REPLIED
            ).count()
            
            bounces = db.query(EmailEvent).filter(
                EmailEvent.campaign_id == campaign_id,
                EmailEvent.sequence_step_id.in_(step_ids),
                EmailEvent.event_type == EmailEventType.BOUNCED
            ).count()
            
            opens = db.query(EmailEvent).filter(
                EmailEvent.campaign_id == campaign_id,
                EmailEvent.sequence_step_id.in_(step_ids),
                EmailEvent.event_type == EmailEventType.OPENED
            ).count()
        else:
            emails_sent = replies = bounces = opens = 0
        
        def rate(num, den):
            return round((num / den * 100), 1) if den > 0 else 0.0
            
        result.append({
            "variant_id": seq.id,
            "name": seq.name,
            "weight": seq.variant_weight,
            "is_main": seq.is_main_variant,
            "leads_assigned": leads_assigned,
            "emails_sent": emails_sent,
            "replies": replies,
            "opens": opens,
            "bounces": bounces,
            "reply_rate": rate(replies, max(emails_sent, 1)),
            "open_rate": rate(opens, max(emails_sent, 1)),
            "bounce_rate": rate(bounces, max(emails_sent, 1)),
        })
        
    return result


@router.get("/email-accounts/google/auth-url")
def google_auth_url(user: User = Depends(get_current_user)):
    from app.core.config import settings
    import urllib.parse
    scopes = "https://mail.google.com/ https://www.googleapis.com/auth/userinfo.email"
    params = {
        "client_id": settings.GOOGLE_CLIENT_ID,
        "redirect_uri": "http://localhost:8000/api/email-accounts/google/callback",
        "response_type": "code",
        "scope": scopes,
        "access_type": "offline",
        "prompt": "consent",
        "state": str(user.id)
    }
    return {"url": "https://accounts.google.com/o/oauth2/v2/auth?" + urllib.parse.urlencode(params)}


@router.get("/email-accounts/google/callback")
async def google_callback(code: str, state: str, db: Session = Depends(get_db)):
    from app.core.config import settings
    from fastapi.responses import HTMLResponse
    import httpx
    
    user_id = int(state)
    token_url = "https://oauth2.googleapis.com/token"
    payload = {
        "code": code,
        "client_id": settings.GOOGLE_CLIENT_ID,
        "client_secret": settings.GOOGLE_CLIENT_SECRET,
        "redirect_uri": "http://localhost:8000/api/email-accounts/google/callback",
        "grant_type": "authorization_code"
    }
    
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.post(token_url, data=payload, timeout=10)
            resp.raise_for_status()
            token_data = resp.json()
            
            user_info_url = "https://www.googleapis.com/oauth2/v2/userinfo"
            headers = {"Authorization": f"Bearer {token_data['access_token']}"}
            user_resp = await client.get(user_info_url, headers=headers)
            user_resp.raise_for_status()
            user_data = user_resp.json()
            email = user_data["email"]
            
            token_data["expires_at"] = int(datetime.utcnow().timestamp()) + token_data.get("expires_in", 3600)
            
            account = db.query(EmailAccount).filter(
                EmailAccount.email == email,
                EmailAccount.owner_id == user_id
            ).first()
            
            if not account:
                account = EmailAccount(
                    owner_id=user_id,
                    email=email,
                    name=email.split("@")[0].capitalize(),
                    smtp_host="smtp.gmail.com",
                    smtp_port=587,
                    smtp_username=email,
                    smtp_password_encrypted="",
                    use_tls=True,
                    imap_host="imap.gmail.com",
                    imap_port=993,
                    imap_use_ssl=True,
                    provider="google",
                    oauth_token=token_data
                )
                db.add(account)
            else:
                account.provider = "google"
                account.oauth_token = token_data
                account.smtp_host = "smtp.gmail.com"
                account.smtp_port = 587
                account.smtp_username = email
                account.imap_host = "imap.gmail.com"
                account.imap_port = 993
                account.imap_use_ssl = True
                
            db.commit()
            return HTMLResponse(content="<html><body><script>window.close();</script>Authentication successful! You can close this window.</body></html>")
    except Exception as e:
        raise HTTPException(400, f"Google OAuth authentication failed: {str(e)}")


@router.get("/email-accounts/microsoft/auth-url")
def microsoft_auth_url(user: User = Depends(get_current_user)):
    from app.core.config import settings
    import urllib.parse
    scopes = "offline_access https://outlook.office.com/SMTP.Send https://outlook.office.com/IMAP.AccessAsUser.All https://graph.microsoft.com/User.Read"
    params = {
        "client_id": settings.MICROSOFT_CLIENT_ID,
        "redirect_uri": "http://localhost:8000/api/email-accounts/microsoft/callback",
        "response_type": "code",
        "scope": scopes,
        "response_mode": "query",
        "state": str(user.id)
    }
    return {"url": "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?" + urllib.parse.urlencode(params)}


@router.get("/email-accounts/microsoft/callback")
async def microsoft_callback(code: str, state: str, db: Session = Depends(get_db)):
    from app.core.config import settings
    from fastapi.responses import HTMLResponse
    import httpx
    
    user_id = int(state)
    token_url = "https://login.microsoftonline.com/common/oauth2/v2.0/token"
    payload = {
        "client_id": settings.MICROSOFT_CLIENT_ID,
        "client_secret": settings.MICROSOFT_CLIENT_SECRET,
        "code": code,
        "redirect_uri": "http://localhost:8000/api/email-accounts/microsoft/callback",
        "grant_type": "authorization_code"
    }
    
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.post(token_url, data=payload, timeout=10)
            resp.raise_for_status()
            token_data = resp.json()
            
            graph_url = "https://graph.microsoft.com/v1.0/me"
            headers = {"Authorization": f"Bearer {token_data['access_token']}"}
            user_resp = await client.get(graph_url, headers=headers)
            user_resp.raise_for_status()
            user_data = user_resp.json()
            email = user_data.get("mail") or user_data.get("userPrincipalName")
            
            token_data["expires_at"] = int(datetime.utcnow().timestamp()) + token_data.get("expires_in", 3600)
            
            account = db.query(EmailAccount).filter(
                EmailAccount.email == email,
                EmailAccount.owner_id == user_id
            ).first()
            
            if not account:
                account = EmailAccount(
                    owner_id=user_id,
                    email=email,
                    name=email.split("@")[0].capitalize(),
                    smtp_host="smtp.office365.com",
                    smtp_port=587,
                    smtp_username=email,
                    smtp_password_encrypted="",
                    use_tls=True,
                    imap_host="outlook.office365.com",
                    imap_port=993,
                    imap_use_ssl=True,
                    provider="microsoft",
                    oauth_token=token_data
                )
                db.add(account)
            else:
                account.provider = "microsoft"
                account.oauth_token = token_data
                account.smtp_host = "smtp.office365.com"
                account.smtp_port = 587
                account.smtp_username = email
                account.imap_host = "outlook.office365.com"
                account.imap_port = 993
                account.imap_use_ssl = True
                
            db.commit()
            return HTMLResponse(content="<html><body><script>window.close();</script>Authentication successful! You can close this window.</body></html>")
    except Exception as e:
        raise HTTPException(400, f"Microsoft OAuth authentication failed: {str(e)}")


@router.post("/email-accounts/{account_id}/test")
def test_saved_account(
    account_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user)
):
    account = db.query(EmailAccount).filter(
        EmailAccount.id == account_id,
        EmailAccount.owner_id == user.id
    ).first()
    if not account:
        raise HTTPException(404, "Email account not found")
        
    import smtplib
    from email.mime.text import MIMEText
    from app.services.email_sender import get_fresh_oauth_token, generate_xoauth2_string
    from app.core.encryption import decrypt_password
    
    try:
        msg = MIMEText("This is a test email from ColdReach to verify SMTP connections.", "plain")
        msg["From"] = f"{account.name} <{account.email}>"
        msg["To"] = account.email
        msg["Subject"] = "ColdReach SMTP Test Connection"
        
        if account.use_tls:
            server = smtplib.SMTP(account.smtp_host, account.smtp_port, timeout=10)
            server.ehlo()
            server.starttls()
            server.ehlo()
        else:
            server = smtplib.SMTP_SSL(account.smtp_host, account.smtp_port, timeout=10)
            server.ehlo()
            
        if account.provider in ("google", "microsoft") and account.oauth_token:
            access_token = get_fresh_oauth_token(db, account)
            auth_string = generate_xoauth2_string(account.email, access_token)
            status_code, response = server.docmd("AUTH", f"XOAUTH2 {auth_string}")
            if status_code != 235:
                raise Exception(f"XOAUTH2 authentication failed: {status_code} {response.decode()}")
        else:
            password = decrypt_password(account.smtp_password_encrypted)
            server.login(account.smtp_username, password)
            
        server.sendmail(account.email, [account.email], msg.as_string())
        server.quit()
        return {"status": "success", "message": f"Test email sent successfully to {account.email}"}
    except Exception as e:
        raise HTTPException(400, f"SMTP Connection test failed: {str(e)}")


@router.post("/campaigns/{campaign_id}/settings/change-preview")
def settings_change_preview(
    campaign_id: int,
    payload: CampaignUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    from datetime import timedelta
    _get_campaign_or_404(db, campaign_id, user.id)
    
    reschedule_count = 0
    cancel_count = 0
    
    scheduled_emails = db.query(ScheduledEmail).filter(
        ScheduledEmail.campaign_id == campaign_id,
        ScheduledEmail.is_sent == False,
        ScheduledEmail.is_cancelled == False,
    ).all()
    
    if payload.daily_email_limit is not None:
        campaign = db.query(Campaign).get(campaign_id)
        if payload.daily_email_limit < campaign.daily_email_limit:
            today_start = datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
            today_end = today_start + timedelta(days=1)
            scheduled_today_count = db.query(ScheduledEmail).filter(
                ScheduledEmail.campaign_id == campaign_id,
                ScheduledEmail.is_sent == False,
                ScheduledEmail.is_cancelled == False,
                ScheduledEmail.scheduled_for >= today_start,
                ScheduledEmail.scheduled_for < today_end
            ).count()
            if scheduled_today_count > payload.daily_email_limit:
                cancel_count = scheduled_today_count - payload.daily_email_limit
                
    if any(f is not None for f in [payload.timezone, payload.active_days, payload.sending_window_start, payload.sending_window_end]):
        reschedule_count = len(scheduled_emails)
        
    return {
        "scheduled_emails_count": len(scheduled_emails),
        "reschedule_count": reschedule_count,
        "cancel_count": cancel_count,
        "message": f"Saving these changes will reschedule {reschedule_count} emails and cancel {cancel_count} emails scheduled for today."
    }


@router.get("/campaigns/{campaign_id}/settings/history")
def settings_change_history(
    campaign_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    from app.models import CampaignChangeEvent
    _get_campaign_or_404(db, campaign_id, user.id)
    events = db.query(CampaignChangeEvent).filter(
        CampaignChangeEvent.campaign_id == campaign_id
    ).order_by(CampaignChangeEvent.created_at.desc()).all()
    
    return [
        {
            "id": ev.id,
            "change_type": ev.change_type,
            "old_value": ev.old_value,
            "new_value": ev.new_value,
            "changed_by": ev.changed_by,
            "applied_at": ev.applied_at,
            "cascade_result": ev.cascade_result,
            "created_at": ev.created_at
        }
        for ev in events
    ]


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _get_campaign_or_404(db, campaign_id, user_id):
    c = db.query(Campaign).filter(Campaign.id == campaign_id, Campaign.owner_id == user_id).first()
    if not c:
        raise HTTPException(404, "Campaign not found")
    return c