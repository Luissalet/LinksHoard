import React from "react";
import LinkList from "../components/LinkList.jsx";

export default function Todo() {
  return <LinkList title="Todo" description="Todos los enlaces guardados, leídos o no, sin archivar." state="all" showSave />;
}
