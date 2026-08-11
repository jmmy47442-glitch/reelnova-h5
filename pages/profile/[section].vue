<script setup lang="ts">
import {
  ArrowLeft, Check, ChevronDown, ChevronRight, CircleHelp, Clock3, Download,
  ExternalLink, FileText, Globe2, History, LockKeyhole, Mail, MessageCircle,
  Play, ReceiptText, Search, Shield, ShoppingBag, Trash2,
} from 'lucide-vue-next';
import type { OrderStatus } from '~/types/content';

definePageMeta({ hideBottomNav: true });
const route = useRoute();
const api = useContentApi();
const section = String(route.params.section || '');

const pageConfig = {
  purchases: { eyebrow: 'YOUR COLLECTION', title: 'My purchases', description: 'Every story you have unlocked, ready to watch on this account.', icon: ShoppingBag },
  orders: { eyebrow: 'BILLING', title: 'Orders & payments', description: 'Review payment status, totals, and order references.', icon: ReceiptText },
  history: { eyebrow: 'RECENTLY WATCHED', title: 'Watch history', description: 'Pick up where you stopped or revisit a recent story.', icon: History },
  language: { eyebrow: 'APP PREFERENCES', title: 'Language', description: 'Choose the language used for navigation and account screens.', icon: Globe2 },
  privacy: { eyebrow: 'YOUR DATA', title: 'Privacy', description: 'Control how ReelNova uses your activity and account information.', icon: Shield },
  terms: { eyebrow: 'POLICIES', title: 'Terms & refunds', description: 'The essentials about purchases, access, and refund requests.', icon: FileText },
  help: { eyebrow: 'SUPPORT', title: 'Help center', description: 'Quick answers for watching, purchases, and your account.', icon: CircleHelp },
} as const;

if (!(section in pageConfig)) throw createError({ statusCode: 404, statusMessage: 'Account page not found' });
const config = pageConfig[section as keyof typeof pageConfig];
useHead({ title: `${config.title} - ReelNova` });

const needsLibrary = section === 'purchases';
const needsOrders = section === 'orders';
const { data: library, status: libraryStatus, error: libraryError, refresh: refreshLibrary } = await useAsyncData(
  `profile-library-${section}`,
  () => needsLibrary ? api.getLibrary() : Promise.resolve(null),
);
const { data: orders, status: ordersStatus, error: ordersError, refresh: refreshOrders } = await useAsyncData(
  'profile-orders',
  () => needsOrders ? api.getMyOrders() : Promise.resolve(null),
);
const { data: history, status: historyStatus, error: historyError, refresh: refreshHistory } = await useAsyncData(
  'profile-watch-history',
  () => section === 'history' ? api.getWatchHistory() : Promise.resolve(null),
);

const selectedOrder = ref('');
const clearingHistory = ref(false);
const language = ref('en');
const savedLanguage = ref('en');
const notice = ref('');
const noticeTimer = ref<ReturnType<typeof setTimeout>>();
const faqQuery = ref('');
const openFaq = ref(0);
const openTerm = ref(0);
const privacy = reactive({ recommendations: true, analytics: true, marketing: false });

const languages = [
  { code: 'en', name: 'English', native: 'English' },
  { code: 'es', name: 'Spanish', native: 'Espanol' },
  { code: 'pt', name: 'Portuguese', native: 'Portugues' },
  { code: 'fr', name: 'French', native: 'Francais' },
  { code: 'de', name: 'German', native: 'Deutsch' },
];

const faqs = [
  { question: 'How do I restore a purchase?', answer: 'Open Profile and enter the PayPal email or ReelNova order number used at checkout. Verified titles are added to My purchases.' },
  { question: 'Why is an episode still locked?', answer: 'Confirm that you are signed in to the account used for payment, then restore the purchase. If it stays locked, contact support with the order number.' },
  { question: 'Can I watch on another device?', answer: 'Yes. Sign in with the same ReelNova account on the new device. Your purchases and latest watch position will sync automatically.' },
  { question: 'How do refunds work?', answer: 'Refund eligibility depends on playback activity and the payment date. Send your order number to support so the purchase can be reviewed.' },
  { question: 'Where can I find my order number?', answer: 'Order numbers begin with RN- and appear in Orders & payments and in your PayPal receipt.' },
];

const terms = [
  { title: 'Access to purchased stories', body: 'A purchase grants personal, non-transferable streaming access to the listed story while the ReelNova service and your account remain available. It does not transfer ownership of the video files.' },
  { title: 'Payments and renewals', body: 'Story passes are one-time purchases shown in USD. ReelNova does not start a recurring subscription unless a recurring plan is clearly presented and accepted at checkout.' },
  { title: 'Refund requests', body: 'You may request a review within 14 days of purchase. Eligibility can be limited after substantial playback or completion. Approved refunds return to the original payment method.' },
  { title: 'Account responsibilities', body: 'Keep your sign-in details secure and do not share, resell, record, or redistribute ReelNova content. Access may be limited when automated abuse or payment fraud is detected.' },
];

const filteredFaqs = computed(() => {
  const query = faqQuery.value.trim().toLowerCase();
  return query ? faqs.filter((item) => `${item.question} ${item.answer}`.toLowerCase().includes(query)) : faqs;
});
const visibleHistory = computed(() => history.value || []);

const orderLabels: Record<OrderStatus, string> = {
  pending: 'Pending', processing: 'Processing', paid: 'Paid', failed: 'Failed', cancelled: 'Cancelled',
  refunding: 'Refund pending', refunded: 'Refunded', risk_review: 'Under review',
};
const formatDate = (value: string) => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(value));
const formatHistoryDate = (value: string) => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value));
const formatMoney = (amount: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);

const showNotice = (message: string) => {
  notice.value = message;
  if (noticeTimer.value) clearTimeout(noticeTimer.value);
  noticeTimer.value = setTimeout(() => { notice.value = ''; }, 2600);
};

const saveLanguage = () => {
  savedLanguage.value = language.value;
  localStorage.setItem('reelnova-language', language.value);
  showNotice('Language preference saved');
};

const savePrivacy = () => {
  localStorage.setItem('reelnova-privacy', JSON.stringify(privacy));
  showNotice('Privacy preference saved');
};

const clearHistory = async () => {
  if (clearingHistory.value) return;
  clearingHistory.value = true;
  try {
    await api.clearWatchHistory();
    history.value = [];
    showNotice('Watch history cleared from your account');
  } catch {
    showNotice('History could not be cleared. Try again.');
  } finally { clearingHistory.value = false; }
};

const downloadData = () => {
  const payload = JSON.stringify({ exportedAt: new Date().toISOString(), preferences: privacy }, null, 2);
  const url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'reelnova-account-data.json';
  anchor.click();
  URL.revokeObjectURL(url);
  showNotice('Account data downloaded');
};

onMounted(() => {
  const storedLanguage = localStorage.getItem('reelnova-language');
  if (storedLanguage && languages.some((item) => item.code === storedLanguage)) language.value = savedLanguage.value = storedLanguage;
  try {
    const storedPrivacy = JSON.parse(localStorage.getItem('reelnova-privacy') || 'null');
    if (storedPrivacy) Object.assign(privacy, storedPrivacy);
  } catch { /* Ignore invalid local preferences. */ }
});

onBeforeUnmount(() => { if (noticeTimer.value) clearTimeout(noticeTimer.value); });
</script>

<template>
  <div class="content-width page-top account-page">
    <header class="account-toolbar">
      <NuxtLink class="account-toolbar__back" to="/profile" aria-label="Back to profile"><ArrowLeft :size="21" /></NuxtLink>
      <span>Account</span>
      <NuxtLink v-if="section !== 'help'" class="account-toolbar__help" to="/profile/help" aria-label="Open help center"><CircleHelp :size="20" /></NuxtLink>
      <span v-else class="account-toolbar__spacer" />
    </header>

    <header class="account-heading">
      <span class="account-heading__icon"><component :is="config.icon" :size="22" /></span>
      <div><span class="eyebrow">{{ config.eyebrow }}</span><h1>{{ config.title }}</h1><p>{{ config.description }}</p></div>
    </header>

    <main class="account-content">
      <template v-if="section === 'purchases'">
        <PageSkeleton v-if="libraryStatus === 'pending'" />
        <EmptyState v-else-if="libraryError" title="Purchases unavailable" action="Try again" @action="refreshLibrary" />
        <template v-else-if="library?.purchased.length">
          <div class="account-section-label"><span>{{ library.purchased.length }} {{ library.purchased.length === 1 ? 'story' : 'stories' }}</span><small>Lifetime access</small></div>
          <div class="account-media-list">
            <NuxtLink v-for="series in library.purchased" :key="series.id" :to="`/series/${series.slug}`" class="account-media-row">
              <img :src="series.coverUrl" alt="" />
              <div><span class="account-status account-status--owned"><Check :size="11" /> Owned</span><h2>{{ series.title }}</h2><p>{{ series.episodeCount }} episodes · {{ series.updatedLabel }}</p></div>
              <span class="account-row-action"><Play :size="17" fill="currentColor" /></span>
            </NuxtLink>
          </div>
        </template>
        <div v-else class="account-empty"><span><ShoppingBag :size="25" /></span><h2>No purchases yet</h2><p>Stories you unlock will appear here and stay connected to this account.</p><NuxtLink class="button button--primary" to="/explore">Explore stories</NuxtLink></div>
      </template>

      <template v-else-if="section === 'orders'">
        <PageSkeleton v-if="ordersStatus === 'pending'" />
        <EmptyState v-else-if="ordersError" title="Orders unavailable" action="Try again" @action="refreshOrders" />
        <template v-else-if="orders?.length">
          <div class="account-section-label"><span>Order history</span><small>{{ orders.length }} total</small></div>
          <div class="order-list">
            <article v-for="order in orders" :key="order.orderNo" class="order-row" :class="{ 'is-open': selectedOrder === order.orderNo }">
              <button type="button" @click="selectedOrder = selectedOrder === order.orderNo ? '' : order.orderNo">
                <span class="order-row__icon"><ReceiptText :size="19" /></span>
                <span class="order-row__main"><strong>{{ order.seriesTitle }}</strong><small>{{ formatDate(order.createdAt) }} · {{ order.orderNo }}</small></span>
                <span class="order-row__end"><strong>{{ formatMoney(order.amount) }}</strong><small class="account-status" :class="`account-status--${order.status}`">{{ orderLabels[order.status] }}</small></span>
                <ChevronDown :size="18" />
              </button>
              <div v-if="selectedOrder === order.orderNo" class="order-detail">
                <dl><div><dt>Payment method</dt><dd>PayPal</dd></div><div><dt>Currency</dt><dd>{{ order.currency }}</dd></div><div><dt>Order reference</dt><dd>{{ order.orderNo }}</dd></div></dl>
                <NuxtLink :to="{ path: '/explore', query: { q: order.seriesTitle } }">Find purchased story <ChevronRight :size="15" /></NuxtLink>
              </div>
            </article>
          </div>
          <p class="account-footnote"><LockKeyhole :size="14" /> Payment details are handled securely by PayPal.</p>
        </template>
        <div v-else class="account-empty"><span><ReceiptText :size="25" /></span><h2>No orders yet</h2><p>Completed and pending PayPal orders will be listed here.</p><NuxtLink class="button button--primary" to="/explore">Find a story</NuxtLink></div>
      </template>

      <template v-else-if="section === 'history'">
        <PageSkeleton v-if="historyStatus === 'pending'" />
        <EmptyState v-else-if="historyError" title="History unavailable" action="Try again" @action="refreshHistory" />
        <template v-else-if="visibleHistory.length">
          <div class="account-section-label"><span>Latest activity</span><button type="button" :disabled="clearingHistory" @click="clearHistory"><Trash2 :size="14" /> {{ clearingHistory ? 'Clearing…' : 'Clear history' }}</button></div>
          <div class="account-media-list">
            <NuxtLink v-for="series in visibleHistory" :key="series.id" :to="`/watch/${series.slug}/${series.currentEpisode}`" class="account-media-row account-media-row--wide">
              <img :src="series.coverUrl" alt="" />
              <div><span class="account-progress-label"><Clock3 :size="12" /> Episode {{ series.currentEpisode }} of {{ series.episodeCount }}</span><h2>{{ series.title }}</h2><div class="progress-track"><span :style="{ width: `${series.progress}%` }" /></div><p>{{ series.progress }}% watched · {{ formatHistoryDate(series.lastWatchedAt) }}</p></div>
              <span class="account-row-action"><Play :size="17" fill="currentColor" /></span>
            </NuxtLink>
          </div>
        </template>
        <div v-else class="account-empty"><span><History :size="25" /></span><h2>Your history is clear</h2><p>Stories you start watching will appear here for a quick return.</p><NuxtLink class="button button--primary" to="/explore">Start watching</NuxtLink></div>
      </template>

      <template v-else-if="section === 'language'">
        <div class="account-section-label"><span>Display language</span><small>More languages coming soon</small></div>
        <div class="language-list" role="radiogroup" aria-label="Display language">
          <button v-for="item in languages" :key="item.code" type="button" role="radio" :aria-checked="language === item.code" :class="{ 'is-selected': language === item.code }" @click="language = item.code">
            <span class="language-code">{{ item.code.toUpperCase() }}</span><span><strong>{{ item.name }}</strong><small>{{ item.native }}</small></span><span class="language-check"><Check v-if="language === item.code" :size="15" /></span>
          </button>
        </div>
        <button class="button button--primary button--wide account-save" type="button" :disabled="language === savedLanguage" @click="saveLanguage">Save changes</button>
        <p class="account-footnote"><Globe2 :size="14" /> Audio and subtitle options vary by story.</p>
      </template>

      <template v-else-if="section === 'privacy'">
        <div class="account-section-label"><span>Activity controls</span><small>Applied to this account</small></div>
        <section class="preference-list">
          <label><span><strong>Personalized recommendations</strong><small>Use viewing activity to improve your Explore feed.</small></span><input v-model="privacy.recommendations" type="checkbox" @change="savePrivacy" /><i /></label>
          <label><span><strong>Playback analytics</strong><small>Share performance data that helps fix streaming issues.</small></span><input v-model="privacy.analytics" type="checkbox" @change="savePrivacy" /><i /></label>
          <label><span><strong>Product updates</strong><small>Receive occasional news about new stories and features.</small></span><input v-model="privacy.marketing" type="checkbox" @change="savePrivacy" /><i /></label>
        </section>
        <div class="account-section-label account-section-label--spaced"><span>Your information</span></div>
        <section class="account-action-list">
          <button type="button" @click="downloadData"><span><Download :size="18" /></span><div><strong>Download account data</strong><small>Export your current preferences as a JSON file.</small></div><ChevronRight :size="18" /></button>
          <a href="mailto:privacy@reelnova.com"><span><Mail :size="18" /></span><div><strong>Privacy request</strong><small>Ask to review or delete personal information.</small></div><ExternalLink :size="17" /></a>
        </section>
        <p class="account-footnote"><Shield :size="14" /> Payment credentials are never stored by ReelNova.</p>
      </template>

      <template v-else-if="section === 'terms'">
        <aside class="policy-summary"><span><FileText :size="21" /></span><div><strong>Policy summary</strong><p>Effective August 10, 2026. This summary highlights common questions and does not replace the complete terms.</p></div></aside>
        <div class="policy-list">
          <article v-for="(item, index) in terms" :key="item.title" :class="{ 'is-open': openTerm === index }">
            <button type="button" @click="openTerm = openTerm === index ? -1 : index"><span>{{ item.title }}</span><ChevronDown :size="18" /></button>
            <p v-if="openTerm === index">{{ item.body }}</p>
          </article>
        </div>
        <section class="refund-callout"><div><strong>Need a refund review?</strong><p>Include your RN order number so support can locate the payment.</p></div><a class="button button--secondary" href="mailto:support@reelnova.com?subject=Refund%20request">Contact support</a></section>
      </template>

      <template v-else-if="section === 'help'">
        <label class="help-search"><Search :size="18" /><input v-model="faqQuery" type="search" placeholder="Search help topics" /><span>{{ filteredFaqs.length }}</span></label>
        <div class="account-section-label"><span>Popular questions</span><small>{{ filteredFaqs.length }} results</small></div>
        <div v-if="filteredFaqs.length" class="policy-list faq-list">
          <article v-for="(item, index) in filteredFaqs" :key="item.question" :class="{ 'is-open': openFaq === index }">
            <button type="button" @click="openFaq = openFaq === index ? -1 : index"><span>{{ item.question }}</span><ChevronDown :size="18" /></button>
            <p v-if="openFaq === index">{{ item.answer }}</p>
          </article>
        </div>
        <div v-else class="account-empty account-empty--compact"><span><Search :size="24" /></span><h2>No matching answers</h2><p>Try a broader search or contact the support team.</p></div>
        <section class="support-band"><span><MessageCircle :size="21" /></span><div><strong>Still need help?</strong><p>Support usually replies within one business day.</p></div><a href="mailto:support@reelnova.com">Email support <ExternalLink :size="14" /></a></section>
      </template>
    </main>

    <Transition name="account-toast"><div v-if="notice" class="account-toast" role="status"><Check :size="16" /> {{ notice }}</div></Transition>
  </div>
</template>
