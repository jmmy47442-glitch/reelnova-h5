const publicUserRoutePatterns = [
  /^\/$/,
  /^\/explore$/,
  /^\/series\/[^/]+$/,
  /^\/watch\/[^/]+\/[^/]+$/,
  /^\/terms$/,
  /^\/(?:login|register)$/,
];

export const isPublicUserRoute = (path: string) => publicUserRoutePatterns.some(pattern => pattern.test(path));
