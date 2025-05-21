function isWithinWorkingHours() {
  const ukHour = new Intl.DateTimeFormat("en-GB", {
    hour: "numeric",
    hour12: false,
    timeZone: "Europe/London"
  }).format(new Date());

  return ukHour >= 7 && ukHour < 22;
}


function delay(ms) {
  return new Promise(res => setTimeout(res, ms));
}

module.exports = { isWithinWorkingHours, delay };
