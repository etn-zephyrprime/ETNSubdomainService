import React from "react";

export default function EcosystemBanner({
  onClick,
  imageSrc,
  alt,
  isMobile,
  objectFit = "contain",
  desktopMaxWidth = 320,
  desktopHeight = 78,
  imageScale = 1,
  imageTranslateY = 0,
}) {
  return (
    <div
      onClick={onClick}
      style={{
        textDecoration: "none",
        width: isMobile ? "100%" : desktopMaxWidth,
        maxWidth: "100%",
        cursor: "pointer",
        boxSizing: "border-box",
      }}
    >
      <div
        style={{
          background: "#0f0f0f",
          border: "1px solid #333",
          borderRadius: 12,
          width: "100%",
          height: isMobile ? 60 : desktopHeight,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          boxShadow: "0 0 8px rgba(0,0,0,0.5)",
          transition: "all 0.2s ease",
          overflow: "hidden",
          padding: isMobile ? 0 : "6px 10px",
          boxSizing: "border-box",
          margin: "0 auto",
        }}
      >
        <div
          style={{
            width: "100%",
            height: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            overflow: "hidden",
          }}
        >
          <img
            src={imageSrc}
            alt={alt}
            style={{
              maxWidth: "100%",
              maxHeight: "100%",
              width: "auto",
              height: "auto",
              objectFit,
              borderRadius: 8,
              display: "block",
              transform: isMobile
                ? "none"
                : `scale(${imageScale}) translateY(${imageTranslateY}px)`,
              transformOrigin: "center center",
            }}
          />
        </div>
      </div>
    </div>
  );
}
