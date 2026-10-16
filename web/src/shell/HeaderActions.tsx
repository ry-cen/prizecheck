import { PhoneAccountButton } from "./AccountSheet";

/**
 * The actions at the end of every phone header (social network, spec "Web screens"): the account avatar now (#246);
 * the Friends and bell buttons join it before the avatar in #247 and #252. The shell's phone header and Collection's
 * own header both draw it, so they stay the same.
 */
export function PhoneHeaderActions() {
  return (
    <div className="hidden shrink-0 items-center gap-1 phone:flex">
      <PhoneAccountButton />
    </div>
  );
}
