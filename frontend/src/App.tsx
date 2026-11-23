import { useEffect } from "react";
import { BrowserRouter, Routes, Route, Navigate, Outlet } from "react-router-dom";

import { AuthProvider, useAuth } from "./context/AuthContext";
import ProtectedRoute from "./components/ProtectedRoute";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import Setup from "./pages/Setup";
import OrganisationInbox from "./pages/OrganisationInbox";

const LEGACY_INBOX_OWNER_UID = "Vy49nGnw74gR5SFHmjN0DOQ2QFE3";

function LegacyInboxRoute() {
  const { user } = useAuth();
  return user?.uid === LEGACY_INBOX_OWNER_UID
    ? <Outlet />
    : <Navigate to="/setup" replace />;
}

export default function App() {
  useEffect(() => {
    function preventNonEditableContextMenu(event: MouseEvent) {
      if (!(event.target instanceof Element)) return;
      const editable = event.target.closest(
        "textarea, [contenteditable='true'], [contenteditable=''], input:not([type='button']):not([type='submit']):not([type='reset']):not([type='checkbox']):not([type='radio']):not([type='range']):not([type='color']):not([type='file']):not([type='image'])"
      );
      if (!editable) event.preventDefault();
    }
    document.addEventListener("contextmenu", preventNonEditableContextMenu, true);
    return () => document.removeEventListener("contextmenu", preventNonEditableContextMenu, true);
  }, []);

  return (
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route element={<ProtectedRoute />}>
            <Route path="/setup" element={<Setup />} />
            <Route path="/org/:orgId/inbox" element={<OrganisationInbox />} />
            <Route element={<LegacyInboxRoute />}>
              <Route path="/" element={<Dashboard />} />
            </Route>
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
