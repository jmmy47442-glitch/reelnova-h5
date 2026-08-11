import { defineNuxtConfig } from 'nuxt/config';

const adminSpaRoutes = {
  routeRules: {
    '/admin/**': { ssr: false },
  },
};

export default defineNuxtConfig({
  compatibilityDate: '2024-11-01',
  buildDir: process.env.REELNOVA_NUXT_BUILD_DIR || '.nuxt',
  devtools: { enabled: false },
  css: ['~/assets/css/main.css'],
  modules: ['@nuxtjs/google-fonts', '@element-plus/nuxt'],
  googleFonts: {
    families: {
      'Barlow Condensed': [600, 700],
      Manrope: [400, 500, 600, 700, 800],
    },
    display: 'swap',
    download: true,
  },
  runtimeConfig: {
    cloudflareAccountId: process.env.CLOUDFLARE_ACCOUNT_ID || '',
    cloudflareD1DatabaseId: process.env.CLOUDFLARE_D1_DATABASE_ID || '',
    cloudflareApiToken: process.env.CLOUDFLARE_API_TOKEN || '',
    cloudflareMediaBaseUrl: process.env.CLOUDFLARE_MEDIA_BASE_URL || '',
    cloudflareMediaSigningSecret: process.env.CLOUDFLARE_MEDIA_SIGNING_SECRET || '',
    cloudflareMediaWorkerUrl: process.env.CLOUDFLARE_MEDIA_WORKER_URL || '',
    cloudflareMediaWorkerSecret: process.env.CLOUDFLARE_MEDIA_WORKER_SECRET || '',
    cloudflareStreamCustomerCode: process.env.CLOUDFLARE_STREAM_CUSTOMER_CODE || '',
    cloudflareStreamWebhookSecret: process.env.CLOUDFLARE_STREAM_WEBHOOK_SECRET || '',
    publicMockContentFallback: process.env.REELNOVA_PUBLIC_MOCK_FALLBACK || 'true',
    domainCnameTarget: process.env.CLOUDFLARE_DOMAIN_CNAME_TARGET || 'domains.reelnova-edge.net',
    paypalClientId: process.env.PAYPAL_CLIENT_ID || '',
    paypalSecret: process.env.PAYPAL_SECRET || '',
    paypalWebhookId: process.env.PAYPAL_WEBHOOK_ID || '',
    paypalEnvironment: process.env.PAYPAL_ENVIRONMENT || 'sandbox',
    superAdminEmail: process.env.SUPER_ADMIN_EMAIL || 'admin@reelnova.com',
    superAdminPassword: process.env.SUPER_ADMIN_PASSWORD || 'ReelNova@2026',
    superAdminName: process.env.SUPER_ADMIN_NAME || 'ReelNova 超级管理员',
    adminSessionSecret: process.env.ADMIN_SESSION_SECRET || process.env.SUPER_ADMIN_PASSWORD || 'reelnova-development-session-secret',
    userSessionSecret: process.env.USER_SESSION_SECRET || process.env.ADMIN_SESSION_SECRET || 'reelnova-development-user-session-secret',
    cloudflareAccessRequired: process.env.CLOUDFLARE_ACCESS_REQUIRED || (process.env.NODE_ENV === 'production' ? 'true' : 'false'),
    public: {
      apiBase: process.env.NUXT_PUBLIC_API_BASE || '/api',
      paypalClientId: process.env.NUXT_PUBLIC_PAYPAL_CLIENT_ID || '',
    },
  },
  ...adminSpaRoutes,
  app: {
    head: {
      title: 'ReelNova - Stories that move fast',
      htmlAttrs: { 'data-theme': 'dark' },
      meta: [
        { name: 'description', content: 'Watch original short dramas, free to start.' },
        { name: 'theme-color', content: '#09090d' },
        { name: 'viewport', content: 'width=device-width, initial-scale=1, viewport-fit=cover' },
      ],
      link: [{ rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' }],
      script: [{
        innerHTML: "(function(){try{var theme=localStorage.getItem('reelnova-theme');if(theme==='light'||theme==='dark'){document.documentElement.dataset.theme=theme;document.documentElement.style.colorScheme=theme;var meta=document.querySelector('meta[name=\"theme-color\"]');if(meta)meta.setAttribute('content',theme==='light'?'#f7f8fb':'#09090d')}}catch(error){}})();",
        tagPosition: 'head',
      }],
    },
  },
});
