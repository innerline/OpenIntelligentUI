import { redirect } from "next/navigation";

// The cockpit's default surface is the Honey chat.
export default function CockpitIndexPage() {
  redirect("/cockpit/honey");
}
