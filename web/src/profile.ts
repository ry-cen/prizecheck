import { useEffect, useState } from "react";

/** The signed-in collector's provider name and picture and their email, from GET /auth/session. */
export type Profile = {
  name: string | null;
  image: string | null;
  email: string | null;
};

export function useProfile(): Profile | null {
  const [profile, setProfile] = useState<Profile | null>(null);
  useEffect(() => {
    let live = true;
    fetch("/auth/session", { credentials: "same-origin" })
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => {
        if (!live || body?.signedIn !== true) return;
        setProfile({
          name: typeof body.name === "string" && body.name ? body.name : null,
          image:
            typeof body.image === "string" && body.image.startsWith("https://")
              ? body.image
              : null,
          email: typeof body.email === "string" ? body.email : null,
        });
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return profile;
}

/** The avatar letter without a picture: the first letter of the collector's email. */
export function initialOf(profile: Profile): string {
  return (profile.email || "?").trim().charAt(0).toUpperCase() || "?";
}
