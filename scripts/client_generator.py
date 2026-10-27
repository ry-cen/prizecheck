"""Shared knowledge for the generated TypeScript clients (``web/src/*_generated.ts``).

Every ``scripts/generate_*client.py`` is a small emitter: it names its target file, the OpenAPI schemas it exports as
types, and its routes and domain-specific errors. This module owns what they had in common: loading the contract,
rendering schemas as TypeScript types, the transport text proven in the current outputs (the fetch scaffold and the
error class), and writing or checking the file. It only produces text for the generated files; the browser gets no
new helper module from it.

An emitter module defines ``TARGET`` (the file under the repository root) and ``render(openapi) -> str``, and ends with
``if __name__ == "__main__": client_generator.main(__name__)``. ``scripts/generate_all_clients.py`` runs every emitter.
"""
import json
import sys
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "api"))

SCALARS = {"string": "string", "integer": "number", "number": "number", "boolean": "boolean", "null": "null"}


def load_openapi():
    """The FastAPI app's OpenAPI document (the generated clients' only input)."""
    from app.main import app  # noqa: E402

    return app.openapi()


@dataclass(frozen=True)
class TypeStyle:
    """How a client renders schemas. Every field is a domain choice or a cosmetic one kept so output stays identical.

    quote: the quote character for string-literal unions (enum and const values).
    parenthesize_arrays: "unions" wraps an array's element only when it is a union (``(A | B)[]``, the only correct
        form); "always" also wraps a plain element (``(string)[]``), which two clients' outputs still carry.
    optional_marks: False when the route serializes every field, so each field is present although the model has a
        default (the price, format check and catalog browse clients).
    """

    quote: str = "'"
    parenthesize_arrays: str = "unions"
    optional_marks: bool = True

    def literal(self, value):
        return json.dumps(value) if self.quote == '"' else f"'{value}'"

    def ts_type(self, value):
        if "$ref" in value:
            return value["$ref"].split("/")[-1]
        if "const" in value:
            return self.literal(value["const"])
        if "enum" in value:
            return " | ".join(self.literal(option) for option in value["enum"])
        if "anyOf" in value:
            return " | ".join(self.ts_type(part) for part in value["anyOf"])
        kind = value.get("type")
        if kind == "array":
            inner = self.ts_type(value["items"])
            wrap = " | " in inner or self.parenthesize_arrays == "always"
            return f"({inner})[]" if wrap else f"{inner}[]"
        if kind == "object":
            return "Record<string, unknown>"
        return SCALARS[kind]

    def fields(self, definition, only=None, all_required=False):
        """``name?: type`` for each property of an object schema (``only`` filters the property names;
        ``all_required`` leaves out every ``?``, for fields added on top of another type)."""
        required = definition.get("required", [])
        present = all_required or not self.optional_marks
        return [f"{field}{'' if present or field in required else '?'}: {self.ts_type(value)}"
                for field, value in definition["properties"].items() if only is None or only(field)]

    def alias(self, name, definition, only=None):
        return f"export type {name} = {{ {'; '.join(self.fields(definition, only))} }};"

    def aliases(self, schemas, names):
        return [self.alias(name, schemas[name]) for name in names]


SINGLE = TypeStyle()
DOUBLE = TypeStyle(quote='"')


def header(script, source=True):
    """The first line of a generated file."""
    origin = "from FastAPI OpenAPI " if source else ""
    return f"// Generated {origin}by scripts/{script}.py. Do not edit."


def assemble(lines, trailing=""):
    """The file text: lines joined by newlines. The last line is the body, which carries its own final newline."""
    return "\n".join(lines) + trailing


# Transport text. The error constructor is always (status, code, ...extra); a domain adds what its API's refusals carry.

def error_class(name, extra="", doc=None, constructor_doc=None):
    """A client's error class. ``extra`` is the constructor's trailing parameters, e.g.
    ``public detail: Record<string, unknown> = {}``; ``doc`` comments the class, ``constructor_doc`` its constructor."""
    parameters = f"public status: number, public code: string{', ' + extra if extra else ''}"
    lead = f"{doc}\n" if doc else ""
    inner = f"  {constructor_doc}\n" if constructor_doc else ""
    return f"{lead}export class {name} extends Error {{\n{inner}  constructor({parameters}) {{ super(code); }}\n}}"


def failure_block(error, default_code, indent=2):
    """Throws ``error`` with the API's ``detail.code`` (or the domain default) when the response is not ok."""
    pad = " " * indent
    return (f"{pad}if (!response.ok) {{\n"
            f"{pad}  const payload = await response.json().catch(() => ({{}}));\n"
            f"{pad}  throw new {error}(response.status, payload?.detail?.code ?? '{default_code}');\n"
            f"{pad}}}")


def detail_failure_lines(error, default_code):
    """Failure body lines for an error that carries the API's whole detail object (empty when it is not an object)."""
    return (f"    const detail = payload?.detail && typeof payload.detail === 'object' ? payload.detail : {{}};\n"
            f"    throw new {error}(response.status, detail.code ?? '{default_code}', detail);")


def json_request(failure, method="method: string", signal=False, on_response=False):
    """The ``request<T>`` function: JSON body when one is given, same-origin cookies, and ``failure`` lines on a refusal.

    method: the method parameter, with or without a default (``method = 'GET'``).
    signal: accepts an AbortSignal and passes it to fetch (cancellation).
    on_response: accepts a callback that sees the ok response first (to read a header).
    """
    parameters = f"path: string, {method}, body?: object"
    if signal:
        parameters += ", signal?: AbortSignal"
    if on_response:
        parameters += ", onResponse?: (response: Response) => void"
    options = "{ method, credentials: 'same-origin', signal," if signal else "{ method, credentials: 'same-origin',"
    after = "  onResponse?.(response);\n" if on_response else ""
    return (f"async function request<T>({parameters}): Promise<T> {{\n"
            f"  const response = await fetch(path, {options}\n"
            "    headers: body ? { 'content-type': 'application/json' } : undefined,\n"
            "    body: body ? JSON.stringify(body) : undefined });\n"
            "  if (!response.ok) {\n"
            "    const payload = await response.json().catch(() => ({}));\n"
            f"{failure}\n"
            "  }\n"
            f"{after}"
            "  return response.json() as Promise<T>;\n"
            "}")


def simple_request(failure_error, default_code, **options):
    """``json_request`` whose refusal carries only the API's code."""
    return json_request(f"    throw new {failure_error}(response.status, payload?.detail?.code ?? '{default_code}');",
                        **options)


# Running an emitter.

def main(module_name, argv=None):
    """Write the emitter's file, or with ``--check`` fail when it is not what the emitter renders."""
    module = sys.modules[module_name]
    argv = sys.argv if argv is None else argv
    problem = write_or_check(module, load_openapi(), check="--check" in argv)
    if problem:
        raise SystemExit(problem)


def write_or_check(module, openapi, check):
    """Writes ``module``'s file (returning None), or checks it (returning a message when stale)."""
    target = ROOT / module.TARGET
    content = module.render(openapi)
    if not check:
        target.write_text(content)
        return None
    if not target.exists() or target.read_text() != content:
        return f"{module.TARGET} is stale; run python scripts/{Path(module.__file__).name}"
    return None
