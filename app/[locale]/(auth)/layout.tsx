/**
 * Layout for authentication pages
 * Minimal wrapper - signin page has its own full-screen design
 */
export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
