import Link from "next/link";
import type { Metadata } from "next";
import { getDb } from "@/db/client";
import { requirePageContext } from "@/lib/current-user";
import {
  getNotificationPreference,
  listNotifications,
  NOTIFICATION_CATEGORIES,
} from "@/lib/notifications";
import { formatDateTime } from "@/lib/format";
import { Alert, EmptyState, PageHeader } from "@/components/ui";
import {
  markAllNotificationsReadAction,
  markNotificationReadAction,
  updateNotificationPreferencesAction,
} from "../actions";
import { serviceUnavailable } from "@/lib/page-guards";

export const metadata: Metadata = { title: "Notifications" };
export const dynamic = "force-dynamic";

export default async function NotificationsPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const params = await searchParams;
  const { actor, org } = await requirePageContext("org:read");
  try {
    const db = getDb();
    const [items, ...preferences] = await Promise.all([
      listNotifications(db, actor.user.id, org.orgId),
      ...NOTIFICATION_CATEGORIES.map((category) =>
        getNotificationPreference(db, { userId: actor.user.id, orgId: org.orgId, category }),
      ),
    ]);

    return (
      <>
        <PageHeader
          eyebrow={org.orgName}
          title="Notifications"
          description="In-app alerts and reminder emails. Reminders are deduplicated per UTC day so retries cannot spam you."
          actions={
            <form action={markAllNotificationsReadAction}>
              <input type="hidden" name="returnTo" value="/app/notifications" />
              <button className="btn secondary" type="submit">Mark all read</button>
            </form>
          }
        />
        {params.ok ? <Alert tone="success">{params.ok}</Alert> : null}
        {params.error ? <Alert tone="error">{params.error}</Alert> : null}

        <div className="grid grid-2 section" style={{ alignItems: "start" }}>
          <div className="card">
            <div className="card-head"><h2>Inbox</h2><span className="small muted">{items.filter((item) => !item.readAt).length} unread</span></div>
            {items.length === 0 ? (
              <EmptyState title="No notifications yet">Reminders about tasks, documents and tender deadlines will appear here.</EmptyState>
            ) : (
              <ul className="list card-pad">
                {items.map((item) => (
                  <li key={item.id} style={{ background: item.readAt ? undefined : "#fcfaf4", margin: "0 -1.25rem", padding: "0.75rem 1.25rem" }}>
                    <div className="row-between">
                      <div>
                        <div className="strong small">{item.href ? <Link href={item.href}>{item.title}</Link> : item.title}</div>
                        {item.body ? <div className="tiny muted">{item.body}</div> : null}
                        <div className="tiny muted">{item.type} · {formatDateTime(item.createdAt)}</div>
                      </div>
                      {!item.readAt ? (
                        <form action={markNotificationReadAction}>
                          <input type="hidden" name="returnTo" value="/app/notifications" />
                          <input type="hidden" name="notificationId" value={item.id} />
                          <button className="btn small secondary" type="submit">Mark read</button>
                        </form>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="card">
            <div className="card-head"><h2>Preferences</h2></div>
            <form action={updateNotificationPreferencesAction} className="card-pad">
              <input type="hidden" name="returnTo" value="/app/notifications" />
              <p className="small muted">Control in-app and email delivery per category for this organization.</p>
              <div className="table-wrap"><table className="data">
                <thead><tr><th>Category</th><th>In-app</th><th>Email</th></tr></thead>
                <tbody>{NOTIFICATION_CATEGORIES.map((category, index) => {
                  const preference = preferences[index] ?? { inAppEnabled: true, emailEnabled: true };
                  return (
                    <tr key={category}>
                      <td className="small strong">{category}</td>
                      <td><input type="checkbox" name={`in_app_${category}`} defaultChecked={preference.inAppEnabled} /></td>
                      <td><input type="checkbox" name={`email_${category}`} defaultChecked={preference.emailEnabled} /></td>
                    </tr>
                  );
                })}</tbody>
              </table></div>
              <button className="btn accent mt-2" type="submit">Save preferences</button>
            </form>
          </div>
        </div>
      </>
    );
  } catch (error) {
    return serviceUnavailable(error, "notifications");
  }
}
