"""The API's one error raiser: a status and a machine-readable code, with optional detail fields beside the code."""
from fastapi import HTTPException


def api_error(status: int, code: str, **detail):
    """Raise the API error. Optional detail names the affected source, Card Edition or destination; each value is sent as
    a string and a None value is left out."""
    raise HTTPException(status, {"code": code, **{key: str(value) for key, value in detail.items() if value is not None}})
