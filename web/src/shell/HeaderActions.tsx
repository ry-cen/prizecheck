import { InboxButton } from "../inbox/Inbox";
import { FriendsButton } from "../social/FriendsDrawer";
import { PhoneAccountButton } from "./AccountSheet";

/**
 * The actions at the end of every phone header (social network, spec "Web screens"): the inbox's bell (#259), the
 * Friends button (#247), then the account avatar (#246). The shell's phone header and Collection's own header both draw
 * it, so they stay the same.
 */
export function PhoneHeaderActions() {
  return (
    <div className="hidden shrink-0 items-center gap-1 phone:flex">
      <InboxButton phone />
      <FriendsButton phone />
      <PhoneAccountButton />
    </div>
  );
}
