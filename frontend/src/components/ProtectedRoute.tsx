import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
const LEGACY_OWNER_UID = "Vy49nGnw74gR5SFHmjN0DOQ2QFE3";
export default function ProtectedRoute({ allowNonOwner = false }: { allowNonOwner?: boolean }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <div className="flex min-h-screen items-center justify-center bg-[#f0f2f5]"><p className="text-sm text-gray-600">Loading JOY INBOX...</p></div>;
  if (!user) return <Navigate to="/login" state={{ from: location }} replace />;
  if (user.uid !== LEGACY_OWNER_UID && !allowNonOwner) return <Navigate to="/setup" replace />;
  return <Outlet />;
}
