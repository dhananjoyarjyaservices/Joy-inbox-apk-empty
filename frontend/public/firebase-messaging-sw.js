importScripts("https://www.gstatic.com/firebasejs/12.5.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/12.5.0/firebase-messaging-compat.js");

const config = Object.fromEntries(new URL(self.location.href).searchParams.entries());
firebase.initializeApp(config);

const messaging = firebase.messaging();

messaging.onBackgroundMessage(async (payload) => {
  const data = payload.data || {};
  const isIncoming = data.type === "incoming_whatsapp_text" && data.chatId && data.messageId;
  const isSlaAlert = data.type === "tenant_sla_overdue" && data.chatId && data.organizationId;
  if (!isIncoming && !isSlaAlert) return;

  const windows = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  if (isIncoming && windows.some((client) => client.visibilityState === "visible")) return;

  const target = new URL("inbox", self.registration.scope);
  target.searchParams.set("chatId", data.chatId);
  if (data.messageId) target.searchParams.set("messageId", data.messageId);

  await self.registration.showNotification(
    data.title || (isSlaAlert ? "First reply SLA overdue" : "New WhatsApp message"),
    {
      body: data.body || (isSlaAlert ? "A customer is waiting for your reply." : "You have a new message."),
      tag: isSlaAlert ? `sla-${data.organizationId}-${data.chatId}` : `whatsapp-${data.messageId}`,
      renotify: isSlaAlert,
      data: { url: target.href },
    },
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || self.registration.scope;

  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({
      type: "window",
      includeUncontrolled: true,
    });
    const appWindow = windows.find((client) => client.url.startsWith(self.registration.scope));

    if (appWindow) {
      await appWindow.navigate(targetUrl);
      await appWindow.focus();
      return;
    }

    await self.clients.openWindow(targetUrl);
  })());
});
