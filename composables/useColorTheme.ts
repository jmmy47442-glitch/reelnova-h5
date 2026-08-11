export type ColorTheme = 'dark' | 'light';

const STORAGE_KEY = 'reelnova-theme';

const applyTheme = (theme: ColorTheme) => {
  if (!import.meta.client) return;

  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'light' ? '#f7f8fb' : '#09090d');
};

export const useColorTheme = () => {
  const theme = useState<ColorTheme>('color-theme', () => 'dark');

  const setTheme = (nextTheme: ColorTheme) => {
    theme.value = nextTheme;
    applyTheme(nextTheme);
    if (import.meta.client) localStorage.setItem(STORAGE_KEY, nextTheme);
  };

  const toggleTheme = () => setTheme(theme.value === 'dark' ? 'light' : 'dark');

  onMounted(() => {
    const savedTheme = localStorage.getItem(STORAGE_KEY);
    const initialTheme: ColorTheme = savedTheme === 'light' || savedTheme === 'dark'
      ? savedTheme
      : document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';

    theme.value = initialTheme;
    applyTheme(initialTheme);
  });

  return {
    theme: readonly(theme),
    isLight: computed(() => theme.value === 'light'),
    setTheme,
    toggleTheme,
  };
};
