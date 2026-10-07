"""Generic owner alert relay. The durable alert ID is the delivery idempotency key."""
import json
import os
from urllib.parse import urlsplit
from urllib.request import Request,build_opener,HTTPRedirectHandler
import psycopg

class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):
        raise ValueError('Mail relay redirects are forbidden')


def deliver_pending(url):
    if os.environ.get('MAIL_SENDER_VERIFIED')!='true' or os.environ.get('MAIL_MODE')!='http':
        return
    relay = os.environ['MAIL_RELAY_URL']
    parsed = urlsplit(relay)
    development = os.environ.get('NODE_ENV')!='production' and os.environ.get('APP_ENV')!='production'
    if parsed.username or parsed.password or parsed.fragment or not parsed.hostname:
        raise ValueError('Invalid relay URL')
    if parsed.scheme!='https' and not (development and parsed.scheme=='http' and parsed.hostname in ('localhost','127.0.0.1','::1')):
        raise ValueError('Secure mail relay required')
    token,sender = os.environ['MAIL_RELAY_TOKEN'],os.environ['MAIL_FROM']
    if not token or not sender:
        raise ValueError('Mail relay configuration incomplete')
    with psycopg.connect(url) as conn:
        recipient = conn.execute('SELECT u.email FROM "user" u JOIN owner_binding b ON b.user_id=u.id WHERE b.singleton AND u."emailVerified"').fetchone()
        if not recipient:
            return
        alerts = conn.execute('SELECT id FROM operations_alert WHERE delivered_at IS NULL AND resolved_at IS NULL ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 10').fetchall()
        for (alert_id,) in alerts:
            message={'from':sender,'to':recipient[0],'subject':'Backup needs attention','text':'No successful private backup has been verified within 25 hours. Check the owner operational health panel.'}
            request = Request(relay,data=json.dumps(message).encode(),headers={'Authorization':'Bearer '+token,'Content-Type':'application/json','Idempotency-Key':str(alert_id)},method='POST')
            with build_opener(NoRedirect).open(request,timeout=5) as response:
                if not 200<=response.status<300:
                    raise ValueError('Mail relay rejected alert')
            conn.execute('UPDATE operations_alert SET delivered_at=now() WHERE id=%s',(alert_id,))
