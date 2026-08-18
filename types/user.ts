export interface UserSession {
  userId: string;
  email: string;
  name: string;
  loggedInAt: string;
  expiresAt: string;
}

export interface UserLoginInput {
  email: string;
  password: string;
  remember: boolean;
}

export interface UserRegisterInput extends UserLoginInput {
  name: string;
}

export interface UserPasswordResetInput {
  email: string;
  password: string;
}

export type AccountLanguage = 'en' | 'es' | 'pt' | 'fr' | 'de';

export interface AccountSettings {
  language: AccountLanguage;
  recommendations: boolean;
  analytics: boolean;
  marketing: boolean;
  updatedAt: string | null;
}

export interface AccountDataExport {
  requestId: string;
  exportedAt: string;
  account: {
    userId: string;
    email: string;
    name: string;
    country: string | null;
    device: string | null;
    status: string;
    createdAt: string;
    lastSeenAt: string;
  };
  settings: AccountSettings;
  watchHistory: Array<Record<string, unknown>>;
  orders: Array<Record<string, unknown>>;
  entitlements: Array<Record<string, unknown>>;
  refunds: Array<Record<string, unknown>>;
}
