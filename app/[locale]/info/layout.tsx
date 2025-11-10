/**
 * Layout for info pages (search-mode, welcome-v2, etc.)
 * Removes the fixed body constraint to allow scrolling
 */
export default function InfoLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 w-full h-full overflow-y-auto bg-white dark:bg-[#212121]">
      {children}
    </div>
  );
}
