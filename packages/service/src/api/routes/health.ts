import type { HealthView } from '@seatrelay/contracts';
import type { ApiRoute } from '../context';
import { json } from '../http';

export const healthRoutes: ApiRoute[] = [
  {
    name: 'health',
    method: 'GET',
    pattern: '/health',
    auth: 'none',
    handler: async (_ctx, deps) => {
      const view: HealthView = {
        ok: true,
        service: deps.serviceName ?? 'seatrelay',
        stage: deps.stage,
        time: deps.clock.now(),
      };
      return json(200, view);
    },
  },
];
