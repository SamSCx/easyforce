/* exported initButton */
/* global showStdPageDetails */
"use strict";

// sfdcBody = normal Salesforce page
// ApexCSIPage = Developer Console
// auraLoadingBox = Lightning / Salesforce1
// location.host.endsWith("visualforce.com") = Visualforce page
if (document.querySelector("body.sfdcBody, body.ApexCSIPage, #auraLoadingBox") || location.host.endsWith("visualforce.com")) {
  // We are in a Salesforce org
  chrome.runtime.sendMessage({message: "getSfHost", url: location.href}, sfHost => {
    if (sfHost) {
      initButton(sfHost, false);
    }
  });
}

function initButton(sfHost, inInspector) {
  let rootEl = document.createElement("div");
  rootEl.id = "insext";
  let btn = document.createElement("div");
  btn.className = "insext-btn";
  btn.tabIndex = 0;
  btn.accessKey = "i";
  btn.title = "Show Salesforce details (Alt+I / Shift+Alt+I)";
  rootEl.appendChild(btn);

  // Create SVG with flash icon
  let svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  
  let path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M13 2L3 14h9l-1 8 10-12h-9l1-8z");
  
  svg.appendChild(path);
  btn.appendChild(svg);

  document.body.appendChild(rootEl);

  let popupEl;

  btn.addEventListener("click", function() {
    if (!rootEl.classList.contains("insext-active")) {
      if (!popupEl) {
        // First time opening
        popupEl = document.createElement("iframe");
        popupEl.className = "insext-popup";
        popupEl.src = chrome.extension.getURL("popup.html");
        rootEl.appendChild(popupEl);

        addEventListener("message", handleMessage);
      }
      openPopup();
    } else {
      closePopup();
    }
  });

  function handleMessage(e) {
    if (e.source != popupEl?.contentWindow) {
      return;
    }
    if (e.data.insextInitRequest) {
      popupEl.contentWindow.postMessage({
        insextInitResponse: true,
        sfHost,
        inDevConsole: !!document.querySelector("body.ApexCSIPage"),
        inLightning: !!document.querySelector("#auraLoadingBox"),
        inInspector,
      }, "*");
    }
    if (e.data.insextLoaded) {
      openPopup();
    }
    if (e.data.insextClosePopup) {
      closePopup();
    }
    if (e.data.insextShowStdPageDetails) {
      showStdPageDetails(e.data.insextData, e.data.insextAllFieldSetupLinks);
    }
  }

  function openPopup() {
    rootEl.classList.add("insext-active");
    if (popupEl) {
      popupEl.contentWindow.postMessage({
        insextUpdateRecordId: true,
        locationHref: location.href
      }, "*");
      popupEl.style.display = "block";
      document.body.style.overflow = "hidden"; // Prevent background scroll
    }
  }

  function closePopup() {
    rootEl.classList.remove("insext-active");
    if (popupEl) {
      popupEl.style.display = "none";
      document.body.style.overflow = ""; // Restore scroll
    }
  }
}
