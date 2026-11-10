/**
 * Single source of truth for the primary navigation.
 *
 * Both the desktop bar (Header.astro) and the mobile drawer (BaseLayout.astro)
 * render from this list, so adding a page cannot leave the phone menu behind.
 */
export interface NavItem {
  label: string;
  href: string;
}

export const primaryNav: NavItem[] = [
  { label: 'Home', href: '/' },
  { label: 'Services', href: '/services' },
  { label: 'Work', href: '/work' },
  { label: 'Tools', href: '/automations' },
  { label: 'Process', href: '/process' },
  { label: 'Pricing', href: '/pricing' },
  { label: 'About', href: '/about' },
  { label: 'Blog', href: '/blog' },
  { label: 'Log in', href: '/login' },
];

export const primaryCta: NavItem = { label: 'Email us', href: '/contact' };
