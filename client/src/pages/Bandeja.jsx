import React from "react";
import LinkList from "../components/LinkList.jsx";
import ReadToday from "../components/ReadToday.jsx";

export default function Bandeja() {
  return <LinkList title="Bandeja" description="Lo que has guardado y aún no has leído." state="unread" showSave before={<ReadToday />} />;
}
