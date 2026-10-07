// A company's square: its logo when it has one, its first letter otherwise.
// The caller's class gives it its size and colours, because the join page,
// the sidebar and a list of companies each sit on a different ground.
import React from "react";
import "./company-tile.css";
export default function CompanyTile({ company, className = "" }) {
  const first = [...String(company?.name || "").trim()][0] || "?";
  return (
    <span className={"company-tile " + className} aria-hidden="true">
      {company?.logo_url ? (
        <img src={company.logo_url} alt="" />
      ) : (
        first.toUpperCase()
      )}
    </span>
  );
}
