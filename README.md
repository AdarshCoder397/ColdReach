# ColdReach — Cold Email Platform

A full-featured cold email campaign platform with all the features of Instantly/Smartlead.

## Features

- Campaign management with status control (Draft → Active → Paused)
- Lead import via CSV with custom field support
- Sequence editor with dynamic delay ranges per step
- Sending schedule: active days + time window (randomized for human-like behavior)
- Follow-up priority engine (configurable % split between new vs follow-up emails)
- Auto-stop when lead replies (IMAP polling every 5 min)
- Master inbox: all replies across all campaigns in one place
- Multiple Gmail/SMTP accounts with inbox rotation
- Encrypted credential storage (Fernet)
- Daily email limits per account

---

## Stack

- Backend: Python, FastAPI, SQLAlchemy, PostgreSQL
- Queue: Celery + Redis
- Frontend: React + Vite + Tailwind CSS

---

## Quick Start (Docker)

### 1. Generate a Fernet encryption key

```bash
python3 -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
```

Copy the output and paste it as `ENCRYPTION_KEY` in `docker-compose.yml`.

### 2. Start everything

```bash
docker compose up --build
```

This starts: PostgreSQL, Redis, FastAPI backend (port 8000), Celery worker, Celery beat.

### 3. Start the frontend

```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:3000

---

## Manual Setup (No Docker)

### Backend

```bash
cd backend

# Install Python deps
pip install -r requirements.txt

# Create a .env file
cat > .env << EOF
DATABASE_URL=postgresql://user:pass@localhost:5432/coldreach
REDIS_URL=redis://localhost:6379/0
SECRET_KEY=your-random-secret
ENCRYPTION_KEY=your-fernet-key
EOF

# Create database (PostgreSQL must be running)
createdb coldreach

# Start API
uvicorn main:app --reload --port 8000

# In another terminal: start Celery worker
celery -A app.workers.tasks.celery_app worker --loglevel=info

# In another terminal: start Celery beat (scheduler)
celery -A app.workers.tasks.celery_app beat --loglevel=info
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

---

## Gmail Setup

Gmail requires an **App Password** (not your regular password):

1. Enable 2-Factor Authentication on your Google account
2. Go to: Google Account → Security → 2-Step Verification → App Passwords
3. Create an app password for "Mail"
4. Use `smtp.gmail.com:587` (SMTP) and `imap.gmail.com:993` (IMAP)
5. The username is your full Gmail address

**Daily limit**: Gmail allows ~500 emails/day for regular accounts, more for Google Workspace.

---

## Project Structure

```
coldreach/
├── backend/
│   ├── main.py                      # FastAPI app entry
│   ├── requirements.txt
│   ├── app/
│   │   ├── api/routes.py            # All REST endpoints
│   │   ├── core/
│   │   │   ├── config.py            # Settings
│   │   │   ├── database.py          # SQLAlchemy engine
│   │   │   ├── security.py          # JWT auth
│   │   │   └── encryption.py        # Fernet for SMTP passwords
│   │   ├── models/__init__.py       # All SQLAlchemy models
│   │   ├── schemas/__init__.py      # Pydantic schemas
│   │   ├── services/
│   │   │   ├── email_sender.py      # SMTP sending + personalization
│   │   │   ├── campaign_engine.py   # Daily scheduler + follow-up priority
│   │   │   └── reply_detector.py    # IMAP reply detection
│   │   └── workers/tasks.py         # Celery tasks
└── frontend/
    └── src/App.jsx                  # Full React UI
```

---

## How the sending engine works

Every **1 minute** (Celery beat):
1. Query `scheduled_emails` where `scheduled_for <= now` and `is_sent = false`
2. For each due email: check lead status (skip if replied/bounced), check account daily limit, send via SMTP
3. Mark as sent, update lead status + current_step

Every **midnight** (daily scheduler):
1. For each active campaign, compute `followup_slots` and `new_lead_slots`
2. Queue follow-up emails first (leads in CONTACTED status with remaining steps)
3. Queue new lead first-touch emails (leads in NEW status)
4. Each email gets a random send time within the campaign's sending window

Every **5 minutes** (IMAP poller):
1. Connect to each configured inbox via IMAP
2. Check for unseen emails in the last 24h
3. Match sender email against leads database
4. If match: set lead status → REPLIED, cancel all pending follow-ups, store in master inbox

---

## API Reference

All endpoints under `/api/`:

| Method | Path | Description |
|--------|------|-------------|
| POST | /auth/register | Register |
| POST | /auth/login | Login → JWT token |
| GET | /campaigns | List campaigns |
| POST | /campaigns | Create campaign |
| PATCH | /campaigns/{id} | Update/pause/activate |
| GET | /campaigns/{id}/leads | List leads |
| POST | /campaigns/{id}/leads/import | CSV import |
| GET | /campaigns/{id}/sequences | Get sequences |
| POST | /campaigns/{id}/sequences | Create sequence |
| GET | /email-accounts | List SMTP accounts |
| POST | /email-accounts | Add SMTP account |
| GET | /inbox | Master inbox |
| GET | /inbox/{id} | Full conversation |
| GET | /campaigns/{id}/stats | Campaign analytics |

Interactive API docs at: http://localhost:8000/docs

---

## Next steps (Phase 2)

- [ ] Unsubscribe link handling
- [ ] Bounce detection via IMAP
- [ ] Spintax support: `{Hi|Hello|Hey} {{first_name}}`
- [ ] Domain health monitoring
- [ ] Multiple sequences per campaign (A/B test)
- [ ] Webhook for open/click tracking (add tracking pixel)
- [ ] AI first-line personalization via Anthropic API
