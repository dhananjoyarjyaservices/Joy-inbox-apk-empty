import { lazy, Suspense, useEffect } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";

import { AuthProvider } from "./context/AuthContext";
import ProtectedRoute from "./components/ProtectedRoute";

const Login = lazy(() => import("./pages/Login"));
const Dashboard = lazy(() => import("./pages/Dashboard"));
const Setup = lazy(() => import("./pages/Setup"));
const TenantInbox = lazy(() => import("./pages/TenantInbox"));
const PublicLeadForm = lazy(() => import("./pages/PublicLeadForm"));

function RouteLoadingFallback() {
  return (
    <main className="grid min-h-screen place-items-center bg-gray-50 px-4">
      <div role="status" aria-live="polite" className="flex items-center gap-3 rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm text-gray-600 shadow-sm">
        <span className="h-4 w-4 animate-spin rounded-full border-2 border-[#128c7e] border-t-transparent" aria-hidden="true" />
        Loading Joy Inbox...
      </div>
    </main>
  );
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
    return () => {
      document.removeEventListener("contextmenu", preventNonEditableContextMenu, true);
    };
  }, []);

  return (
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <AuthProvider>
        <Suspense fallback={<RouteLoadingFallback />}>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/form/:formId" element={<PublicLeadForm />} />
            <Route element={<ProtectedRoute allowNonOwner />}>
              <Route path="/setup" element={<Setup />} />
              <Route path="/inbox" element={<TenantInbox />} />
            </Route>
            <Route element={<ProtectedRoute />}>
              <Route path="/" element={<Dashboard />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </AuthProvider>
    </BrowserRouter>
  );
}
