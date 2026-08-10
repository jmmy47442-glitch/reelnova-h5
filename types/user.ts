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
