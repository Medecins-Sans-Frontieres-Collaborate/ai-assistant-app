import { fireEvent, render, screen, within } from '@testing-library/react';

import { AdminAreaId } from '@/lib/services/admin/adminAreas';

import { AdminAreaNav } from '@/components/Admin/AdminAreaNav';

import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let mockPathname = '/admin/agents';
const mockPush = vi.fn();

vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
}));

vi.mock('@/lib/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
  Link: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

/** Every area, deliberately in an order no group uses. */
const ALL_AREAS: AdminAreaId[] = [
  'view-as',
  'limits',
  'channel-profiles',
  'agents',
  'workflows',
  'guides',
  'global-admins',
  'connectors',
  'glossaries',
  'map-datasets',
  'form-templates',
  'channel-sets',
  'announcements',
  'delegations',
  'local-admins',
  'web-search',
];

describe('AdminAreaNav', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPathname = '/admin/agents';
  });

  describe('rail', () => {
    it('renders groups and items in registry order, not in the order granted', () => {
      render(<AdminAreaNav areas={ALL_AREAS} variant="rail" />);

      const headings = screen
        .getAllByRole('heading', { level: 2 })
        .map((h) => h.textContent);
      expect(headings).toEqual([
        'Capabilities',
        'Libraries',
        'Usage',
        'Administration',
      ]);

      // The regression this guards: rail order used to come from the
      // permission resolver's push order, so `workflows` and
      // `channel-profiles` sank to the bottom of their group and two admins
      // with different rights saw different orders.
      const hrefs = screen
        .getAllByRole('link')
        .map((a) => a.getAttribute('href'));
      expect(hrefs).toEqual([
        '/admin/agents',
        '/admin/connectors',
        '/admin/workflows',
        '/admin/web-search',
        '/admin/guides',
        '/admin/glossaries',
        '/admin/map-datasets',
        '/admin/form-templates',
        '/admin/channel-sets',
        '/admin/channel-profiles',
        '/admin/limits',
        '/admin/announcements',
        '/admin/delegations',
        '/admin/local-admins',
        '/admin/global-admins',
        '/admin/view-as',
      ]);
    });

    it('drops a group with nothing the admin may open', () => {
      render(
        <AdminAreaNav
          areas={['agents', 'guides', 'glossaries']}
          variant="rail"
        />,
      );

      const headings = screen
        .getAllByRole('heading', { level: 2 })
        .map((h) => h.textContent);
      expect(headings).toEqual(['Capabilities', 'Libraries']);
      expect(screen.queryByText('Administration')).not.toBeInTheDocument();
      expect(screen.queryByText('Usage')).not.toBeInTheDocument();
    });

    it('indents items past their group heading without drawing an edge stripe', () => {
      render(<AdminAreaNav areas={['agents', 'guides']} variant="rail" />);

      const link = screen.getByRole('link', { name: 'Agents' });
      // Logical padding so the indent flips under RTL.
      expect(link.className).toContain('ps-4');
      expect(link.className).not.toMatch(/border-[lr]/);
    });

    it('keeps the parent highlighted on a nested editor route', () => {
      mockPathname = '/admin/map-datasets/abc123';

      render(
        <AdminAreaNav areas={['agents', 'map-datasets']} variant="rail" />,
      );

      expect(
        screen.getByRole('link', { name: 'Map datasets' }),
      ).toHaveAttribute('aria-current', 'page');
      expect(screen.getByRole('link', { name: 'Agents' })).not.toHaveAttribute(
        'aria-current',
      );
    });
  });

  describe('picker', () => {
    it('groups the options and selects the current area', () => {
      render(<AdminAreaNav areas={ALL_AREAS} variant="picker" />);

      const select = screen.getByRole('combobox', { name: 'Admin areas' });
      expect(select).toHaveValue('agents');

      const groupLabels = Array.from(select.querySelectorAll('optgroup')).map(
        (g) => g.getAttribute('label'),
      );
      expect(groupLabels).toEqual([
        'Capabilities',
        'Libraries',
        'Usage',
        'Administration',
      ]);

      const libraries = select.querySelectorAll('optgroup')[1];
      expect(
        within(libraries as HTMLElement)
          .getAllByRole('option')
          .map((o) => o.textContent),
      ).toEqual([
        'Guides',
        'Glossaries',
        'Map datasets',
        'Form templates',
        'Channel sets',
        'Platforms',
      ]);
    });

    it('navigates to the chosen area', () => {
      render(<AdminAreaNav areas={ALL_AREAS} variant="picker" />);

      fireEvent.change(screen.getByRole('combobox', { name: 'Admin areas' }), {
        target: { value: 'glossaries' },
      });

      expect(mockPush).toHaveBeenCalledWith('/admin/glossaries');
    });

    it('shows a placeholder rather than claiming an area when nothing matches', () => {
      mockPathname = '/admin';

      render(<AdminAreaNav areas={['agents', 'guides']} variant="picker" />);

      const select = screen.getByRole('combobox', { name: 'Admin areas' });
      expect(select).toHaveValue('');
      expect(select.querySelector('option[value=""]')).toBeDisabled();
    });
  });
});
