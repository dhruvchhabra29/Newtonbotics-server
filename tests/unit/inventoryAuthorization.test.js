const auth = require('../../src/middleware/auth');
const inventoryRouter = require('../../src/routes/inventory');
const projectInventoryRouter = require('../../src/routes/projectInventory');
const projectComponentsRouter = require('../../src/routes/projectComponents');
const componentRequestRouter = require('../../src/routes/componentRequests');

function findRoute(router, method, path) {
  return router.stack.find((layer) =>
    layer.route?.path === path && layer.route.methods[method]
  )?.route;
}

function routeHandlers(route) {
  return route.stack.map((layer) => layer.handle);
}

describe('component management authorization', () => {
  it.each([
    { router: inventoryRouter, method: 'post', path: '/equipment', label: 'shared component creation' },
    { router: inventoryRouter, method: 'put', path: '/equipment/:id', label: 'shared component updates' },
    { router: inventoryRouter, method: 'delete', path: '/equipment/:id', label: 'shared component deletion' },
    { router: inventoryRouter, method: 'post', path: '/equipment/:id/adjust-stock', label: 'stock adjustments' },
    { router: inventoryRouter, method: 'post', path: '/categories', label: 'component category creation' },
    { router: inventoryRouter, method: 'put', path: '/categories/:id', label: 'component category updates' },
    { router: inventoryRouter, method: 'delete', path: '/categories/:id', label: 'component category deletion' },
    { router: projectInventoryRouter, method: 'post', path: '/projects/:projectId/components', label: 'project component creation' },
    { router: projectInventoryRouter, method: 'put', path: '/projects/:projectId/components/:componentId', label: 'project component updates' },
    { router: projectInventoryRouter, method: 'delete', path: '/projects/:projectId/components/:componentId', label: 'project component deletion' },
    { router: projectComponentsRouter, method: 'post', path: '/:projectId/components', label: 'legacy project component creation' },
    { router: projectComponentsRouter, method: 'put', path: '/:projectId/components/:componentId', label: 'legacy project component updates' },
    { router: projectComponentsRouter, method: 'delete', path: '/:projectId/components/:componentId', label: 'legacy project component deletion' },
  ])('$label requires admin authorization', ({ router, method, path }) => {
    const route = findRoute(router, method, path);

    expect(route).toBeDefined();
    expect(routeHandlers(route)).toContain(auth.requireAdmin);
  });

  it('allows every authenticated account to submit a component request while reserving review for admins', () => {
    expect(projectInventoryRouter.stack.some((layer) => layer.handle === componentRequestRouter)).toBe(true);
    const submit = findRoute(componentRequestRouter, 'post', '/');
    const approve = findRoute(componentRequestRouter, 'post', '/:id/approve');
    const reject = findRoute(componentRequestRouter, 'post', '/:id/reject');
    expect(routeHandlers(submit)).toContain(auth.verifyToken);
    expect(routeHandlers(submit)).not.toContain(auth.requireTeamMember);
    expect(routeHandlers(submit)).not.toContain(auth.requireAdmin);
    expect(routeHandlers(approve)).toContain(auth.verifyToken);
    expect(routeHandlers(reject)).toContain(auth.verifyToken);
    expect(findRoute(projectInventoryRouter, 'patch', '/requests/:requestId')).toBeUndefined();
  });

  it('still allows project members to read their project components', () => {
    const route = findRoute(projectInventoryRouter, 'get', '/projects/:projectId/components');
    const handlers = routeHandlers(route);

    expect(route).toBeDefined();
    expect(handlers).toContain(auth.requireStudent);
    expect(handlers).toContain(auth.requireProjectTeamMember);
  });

  it('rejects users without admin role or permission', () => {
    const next = jest.fn();

    auth.requireAdmin({ user: { role: 'team_member', permissions: [] } }, {}, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
  });

  it.each([
    { role: 'admin', permissions: [] },
    { role: 'team_member', permissions: ['system:admin'] },
  ])('allows an admin identity: %o', (user) => {
    const next = jest.fn();

    auth.requireAdmin({ user }, {}, next);

    expect(next).toHaveBeenCalledWith();
  });
});