from app.core.database import SessionLocal
from app.models import EmailEvent, EmailEventType
from sqlalchemy import func

db = SessionLocal()
try:
    total_failed = db.query(EmailEvent).filter(EmailEvent.event_type == EmailEventType.FAILED).count()
    print(f"Total Failed Email Events: {total_failed}")
    
    # Group by error message to see common errors
    errors = db.query(EmailEvent.error_message, func.count(EmailEvent.id))\
        .filter(EmailEvent.event_type == EmailEventType.FAILED)\
        .group_by(EmailEvent.error_message)\
        .order_by(func.count(EmailEvent.id).desc())\
        .limit(10).all()
        
    print("\nTop 10 Error Messages:")
    for err, count in errors:
        print(f"- [{count} times]: {err}")
finally:
    db.close()
