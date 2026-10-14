import { Button } from "../ui/Button";
import { TextField } from "../ui/TextField";

export const looksLikeCode = (value: string) => /^[0-9]{6}$/.test(value);

type Props = {
  /** Sends a fresh code to the owner's email. The caller shows what happened in its status line. */
  onSend: () => void;
  code: string;
  onCode: (code: string) => void;
  /** The confirming button, for example "Confirm rule change" or "Confirm decision". */
  confirmLabel: string;
  /** True once everything the decision needs except the code is filled in. */
  ready: boolean;
  busy: boolean;
  onConfirm: () => void;
};

/**
 * The fresh six-digit code step on an Owner controls card (spec "Deciding"): Send code, the code, then the
 * confirming button, which waits for a six-digit code. Rules use it now; the review cards of #168, #170
 * and #171 reuse it.
 */
export function CodeStep({
  onSend,
  code,
  onCode,
  confirmLabel,
  ready,
  busy,
  onConfirm,
}: Props) {
  return (
    <div className="flex flex-wrap items-end gap-2">
      <Button disabled={busy} onClick={onSend}>
        Send code
      </Button>
      <div className="w-36">
        <TextField
          label="Fresh six-digit code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          maxLength={6}
          value={code}
          onChange={(event) => onCode(event.target.value)}
        />
      </div>
      <Button
        variant="primary"
        disabled={busy || !ready || !looksLikeCode(code)}
        onClick={onConfirm}
      >
        {confirmLabel}
      </Button>
    </div>
  );
}
