// Keep the one-use authorization code only in memory and remove it from the address bar.
export const dingCallback = { input: null, error: '' };
if (window.location.pathname === '/dingtalk/callback') {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('authCode') || params.get('code'), state = params.get('state');
  if (code && state) dingCallback.input = { code, state };
  else dingCallback.error = '未完成钉钉授权，请重新绑定。';
  window.history.replaceState(null, '', '/#/dingtalk');
}
