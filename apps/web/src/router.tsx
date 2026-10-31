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
