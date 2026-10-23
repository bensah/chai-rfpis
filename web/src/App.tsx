import { useEffect, useState } from "react";
import { me, signOut, storedUser, type User } from "./api";
import AppHeader from "./components/AppHeader";
import Login from "./components/Login";
import DonorsPage from "./pages/DonorsPage";

export default function App() {
  // Render straight away from the stored session; /me re-checks it in the background and
  // signs out if the account was deactivated or lost its tenant.
  const [user, setUser] = useState<User | null>(() => storedUser());

  useEffect(() => {
    if (!storedUser()) return;
    me().then(setUser).catch((e) => {
      if (e?.status === 401) setUser(null);
    });
  }, []);

  if (!user) return <Login onSignedIn={setUser} />;

  return (
    <div className="min-h-screen bg-white">
      <AppHeader user={user} onSignOut={() => { signOut(); setUser(null); }} />
      <main className="mx-auto max-w-7xl px-4 pb-16 sm:px-6">
        <DonorsPage />
      </main>
    </div>
  );
}
