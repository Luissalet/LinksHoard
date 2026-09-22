import React from "react";
import LinkList from "../components/LinkList.jsx";

export default function Favoritos() {
  return <LinkList title="Favoritos" description="Los enlaces que has marcado con estrella." state="all" favoriteOnly />;
}
