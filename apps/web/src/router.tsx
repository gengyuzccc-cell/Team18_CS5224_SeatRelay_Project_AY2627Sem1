import { createBrowserRouter } from 'react-router-dom';
import { Layout } from './components/Layout';
import { CallbackPage } from './pages/CallbackPage';
import { DashboardPage } from './pages/DashboardPage';
import { HomePage } from './pages/HomePage';
import { MyRegistrationsPage } from './pages/MyRegistrationsPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { NotificationsPage } from './pages/NotificationsPage';
import { OrgsPage } from './pages/OrgsPage';
import { OrgWorkshopsPage } from './pages/OrgWorkshopsPage';
import { WorkshopPage } from './pages/WorkshopPage';

/** Route table (plan §2.6). Deep links work because CloudFront/nginx rewrite 404 → index.html. */
export const ROUTES = [
  { path: '/', description: 'Home: sign-in, my registrations summary, organiser link' },
  { path: '/callback', description: 'OIDC redirect target (authorization code + PKCE)' },
  {
    path: '/workshops/:wsId',
    description: 'Public workshop view, registration form, my status card',
  },
  { path: '/me/registrations', description: 'All my registrations (live + past)' },
  { path: '/me/notifications', description: 'Notification centre, mark read' },
  { path: '/org', description: 'My organisations, create organisation, add organiser' },
  { path: '/org/:orgId/workshops', description: 'Organisation workshops + create wizard' },
  { path: '/org/:orgId/workshops/:wsId', description: 'Organiser dashboard' },
] as const;

export const router = createBrowserRouter([
  {
    path: '/',
    element: <Layout />,
    children: [
      { index: true, element: <HomePage /> },
      { path: 'callback', element: <CallbackPage /> },
      { path: 'workshops/:wsId', element: <WorkshopPage /> },
      { path: 'me/registrations', element: <MyRegistrationsPage /> },
      { path: 'me/notifications', element: <NotificationsPage /> },
      { path: 'org', element: <OrgsPage /> },
      { path: 'org/:orgId/workshops', element: <OrgWorkshopsPage /> },
      { path: 'org/:orgId/workshops/:wsId', element: <DashboardPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);
