"""Owner operational summaries contain counts and timestamps, never private payloads."""
import os
import re
from datetime import datetime
from typing import Literal
from fastapi import APIRouter, Depends
from pydantic import BaseModel
from .main import connect, require_owner, verified_user

router = APIRouter(tags=['operations'])

class QuotaStatus(BaseModel):
    resource: str
    used: int
    allowance: int
    measured_at: datetime
    warning: bool
    verified: bool

class OperationsStatus(BaseModel):
    backup_last_success: datetime | None
    restore_last_success: datetime | None
    backup_state: Literal['unverified','fresh','stale']
    backup_stale: bool
    backup_failures: int
    restore_failures: int
    backup_alerts: int
    watchdog_last_check: datetime | None
    projection_failures: int
    projection_pending: int
    catalog_failures: int
    catalog_pending_reviews: int
    catalog_outbox_pending: int
    catalog_outbox_oldest_seconds: float | None
    api_requests_24h: int
    api_failures_24h: int
    authorization_denials_24h: int
    api_mean_ms_24h: float | None
    sign_in_requests_24h: int
    sign_in_delivery: Literal['recorded','unverified']
    sign_in_delivered: int | None
    sign_in_failed: int | None
    gateway_authorization_denials: int
    signups_24h: int
    daily_signup_cap: int
    signup_warning: bool
    signup_refusals: int
    release_failures: int
    provider_quotas: Literal['recorded','unverified']
    quotas: list[QuotaStatus]

def daily_signup_cap() -> int:
    """DAILY_SIGNUP_CAP as the gateway reads it (auth/src/rateLimits.ts): a whole number, default 100."""
    value = os.environ.get('DAILY_SIGNUP_CAP', '').strip()
    return int(value) if re.fullmatch(r'[0-9]{1,9}', value) else 100

@router.get('/api/admin/operations',response_model=OperationsStatus)
def operations_status(user_id: str = Depends(verified_user)):
    with connect() as conn:
        require_owner(conn,user_id)
        state = conn.execute("""SELECT *,CASE WHEN backup_last_success IS NULL THEN 'unverified'
         WHEN backup_last_success<clock_timestamp()-interval '25 hours' THEN 'stale' ELSE 'fresh' END AS backup_state
         FROM operations_state WHERE singleton""").fetchone()
        totals = conn.execute("""SELECT coalesce(sum(requests),0) AS api_requests_24h,
         coalesce(sum(failures),0) AS api_failures_24h,coalesce(sum(authorization_denials),0) AS authorization_denials_24h,
         CASE WHEN sum(requests)>0 THEN sum(elapsed_ms)::float/sum(requests) END AS api_mean_ms_24h
         FROM operations_hour WHERE hour>=clock_timestamp()-interval '24 hours'""").fetchone()
        counts = conn.execute("""SELECT
         (SELECT count(*) FROM publication_command WHERE NOT projected) AS projection_pending,
         (SELECT count(*) FROM catalog_run WHERE outcome='failed') AS catalog_failures,
         (SELECT count(*) FROM catalog_review WHERE status='pending') AS catalog_pending_reviews,
         (SELECT count(*) FROM catalog_public_outbox WHERE delivered_at IS NULL) AS catalog_outbox_pending,
         (SELECT extract(epoch FROM clock_timestamp()-min(created_at))::float FROM catalog_public_outbox WHERE delivered_at IS NULL) AS catalog_outbox_oldest_seconds,
         (SELECT count(*) FROM auth_send_event WHERE sent_at>=clock_timestamp()-interval '24 hours') AS sign_in_requests_24h,
         (SELECT count(*) FROM auth_rate_event WHERE kind='signup' AND created_at>=clock_timestamp()-interval '24 hours') AS signups_24h""").fetchone()
        counters = {row['name']:row['count'] for row in conn.execute('SELECT name,count FROM operations_counter').fetchall()}
        quotas = conn.execute("SELECT *,used::numeric>=allowance::numeric*0.7 AS warning,measured_at>=clock_timestamp()-interval '25 hours' AS verified FROM operations_quota ORDER BY resource").fetchall()
        # New accounts in the last day against the cap; the warning deliberately sits at 80%, not the quotas' 70%.
        cap = daily_signup_cap()
        return OperationsStatus(sign_in_delivery='recorded' if 'sign_in_delivered' in counters or 'sign_in_failed' in counters else 'unverified',sign_in_delivered=counters.get('sign_in_delivered'),sign_in_failed=counters.get('sign_in_failed'),gateway_authorization_denials=counters.get('authorization_denials',0),daily_signup_cap=cap,signup_warning=counts['signups_24h']*5>=cap*4,signup_refusals=counters.get('too_many_sign_ups',0),release_failures=counters.get('release_failed',0),provider_quotas='recorded' if quotas else 'unverified',quotas=[QuotaStatus(**item) for item in quotas],**{key:value for key,value in state.items() if key!='singleton'},**totals,**counts)
