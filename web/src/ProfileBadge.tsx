import { useState } from "react";
import { initialOf, useProfile } from "./profile";
import "./ProfileBadge.css";

/**
 * The signed-in collector's provider picture (or the first letter of their email) and name. Only the collector sees
 * it. The app-redesign map moves it into the avatar menu; this fixes what it shows.
 */
export function ProfileBadge() {
  const profile = useProfile();
  const [pictureFailed, setPictureFailed] = useState(false);
  if (!profile) return null;
  return (
    <span className="profile-badge">
      {profile.image && !pictureFailed ? (
        <img
          className="profile-badge-avatar"
          src={profile.image}
          alt=""
          width={24}
          height={24}
          referrerPolicy="no-referrer"
          onError={() => setPictureFailed(true)}
        />
      ) : (
        <span
          className="profile-badge-avatar profile-badge-initial"
          aria-hidden="true"
          data-testid="profile-initial"
        >
          {initialOf(profile)}
        </span>
      )}
      {profile.name && (
        <span className="profile-badge-name">{profile.name}</span>
      )}
    </span>
  );
}
