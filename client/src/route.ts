import { useEffect, useState } from 'react';

export type RouteView =
  | { page: 'home' }
  | { page: 'profile' }
  | { page: 'history' }
  | { page: 'workspace'; workspaceId: string }
  | { page: 'team'; teamId: string };

export function parseHash(hash: string): RouteView {
  const [, page, id] = hash.replace(/^#/, '').split('/');
  if (page === 'w' && id) {
    return { page: 'workspace', workspaceId: id };
  }
  if (page === 't' && id) {
    return { page: 'team', teamId: id };
  }
  if (page === 'profile') {
    return { page: 'profile' };
  }
  if (page === 'history') {
    return { page: 'history' };
  }
  return { page: 'home' };
}

export function useHashRoute(): RouteView {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}
