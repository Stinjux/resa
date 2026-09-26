// Client HTTP : jeton de session, erreurs métier de l'API.

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

const TOKEN_KEY = 'resa.token';

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}
export function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* stockage indisponible : la session durera le temps de l'onglet */
  }
}

export async function api<T = any>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(path, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && token) setToken(null);
    throw new ApiError(res.status, data.error?.code ?? 'ERROR', data.error?.message ?? `Erreur ${res.status}`, data.error?.details);
  }
  return data as T;
}

export const get = <T = any>(path: string) => api<T>('GET', path);
export const post = <T = any>(path: string, body?: unknown, headers?: Record<string, string>) => api<T>('POST', path, body ?? {}, headers);
export const put = <T = any>(path: string, body: unknown) => api<T>('PUT', path, body);
export const patch = <T = any>(path: string, body: unknown) => api<T>('PATCH', path, body);

export interface Role {
  clubId: string | null;
  role: 'org_admin' | 'club_admin' | 'receptionist' | 'starter';
}
export interface User {
  userId: string;
  displayName: string;
  customerId: string | null;
  partnerId?: string | null;
  partnerName?: string | null;
  roles: Role[];
}
export interface Club {
  id: string;
  code: string;
  name: string;
  timezone: string;
  currency: string;
}
export interface Course {
  id: string;
  name: string;
  allowedHoles: number[];
}

/** Téléchargement d'un fichier protégé (jeton de session). */
export async function download(path: string, filename: string): Promise<void> {
  const token = getToken();
  const res = await fetch(path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  if (!res.ok) throw new ApiError(res.status, 'ERROR', `Téléchargement impossible (${res.status})`);
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
