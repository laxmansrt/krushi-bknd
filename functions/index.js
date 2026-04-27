/**
 * KrishiRent AI — Cloud Functions
 * Google AI Solutions Hackathon 2026
 *
 * Functions:
 * 1. onBookingCreated — Send FCM to owner + SMS via MSG91
 * 2. onBookingStatusChange — Notify renter of confirmation/cancellation
 * 3. onEquipmentAdded — Notify nearby renters
 * 4. scheduledReminder — 24h before booking reminder
 */

const functions = require("firebase-functions");
const admin = require("firebase-admin");
const axios = require("axios");

admin.initializeApp();

const db = admin.firestore();
const messaging = admin.messaging();

// ┌──────────────────────────────────────────────┐
// │  MSG91 SMS Configuration                      │
// │  Get your auth key from: https://msg91.com   │
// └──────────────────────────────────────────────┘
const MSG91_AUTH_KEY = functions.config().msg91?.auth_key || "YOUR_MSG91_AUTH_KEY";
const MSG91_TEMPLATE_BOOKING = functions.config().msg91?.template_booking || "YOUR_TEMPLATE_ID";
const MSG91_TEMPLATE_CONFIRM = functions.config().msg91?.template_confirm || "YOUR_TEMPLATE_ID";

// ══════════════════════════════════════════════════════
// ══ FUNCTION 1: ON BOOKING CREATED
// ══ Triggers when a new booking document is created
// ══════════════════════════════════════════════════════

exports.onBookingCreated = functions.firestore
  .document("bookings/{bookingId}")
  .onCreate(async (snap, context) => {
    const booking = snap.data();
    const bookingId = context.params.bookingId;

    console.log(`New booking created: ${bookingId}`);

    try {
      // 1. Get owner details
      const ownerDoc = await db.collection("users").doc(booking.ownerId).get();
      if (!ownerDoc.exists) {
        console.error("Owner not found:", booking.ownerId);
        return;
      }
      const owner = ownerDoc.data();

      // 2. Get renter details
      const renterDoc = await db.collection("users").doc(booking.renterId).get();
      const renter = renterDoc.exists ? renterDoc.data() : { name: "A farmer" };

      // 3. Send FCM push notification to owner
      if (owner.fcmToken) {
        const fcmPayload = {
          notification: {
            title: "New Booking Request!",
            body: `${renter.name} wants to rent your ${booking.equipmentName}`,
          },
          data: {
            type: "booking_request",
            bookingId: bookingId,
            equipmentName: booking.equipmentName,
            renterName: renter.name,
            totalAmount: String(booking.totalAmount),
            startDate: booking.startDate,
            endDate: booking.endDate,
          },
          token: owner.fcmToken,
        };

        await messaging.send(fcmPayload);
        console.log(`FCM sent to owner: ${owner.name}`);
      }

      // 4. Send SMS to owner via MSG91
      if (owner.phone && MSG91_AUTH_KEY !== "YOUR_MSG91_AUTH_KEY") {
        await sendSMS(
          owner.phone,
          MSG91_TEMPLATE_BOOKING,
          {
            renter_name: renter.name,
            equipment: booking.equipmentName,
            amount: `₹${booking.totalAmount}`,
            dates: `${booking.startDate} to ${booking.endDate}`,
          }
        );
        console.log(`SMS sent to owner: ${owner.phone}`);
      }

    } catch (error) {
      console.error("Error in onBookingCreated:", error);
    }
  });

// ══════════════════════════════════════════════════════
// ══ FUNCTION 2: ON BOOKING STATUS CHANGE
// ══ Triggers when booking status is updated
// ══════════════════════════════════════════════════════

exports.onBookingStatusChange = functions.firestore
  .document("bookings/{bookingId}")
  .onUpdate(async (change, context) => {
    const before = change.before.data();
    const after = change.after.data();
    const bookingId = context.params.bookingId;

    // Only trigger on status changes
    if (before.status === after.status) return;

    console.log(`Booking ${bookingId}: ${before.status} → ${after.status}`);

    try {
      // Get renter details
      const renterDoc = await db.collection("users").doc(after.renterId).get();
      if (!renterDoc.exists) return;
      const renter = renterDoc.data();

      const ownerDoc = await db.collection("users").doc(after.ownerId).get();
      const owner = ownerDoc.exists ? ownerDoc.data() : { name: "Equipment Owner" };

      let title = "";
      let body = "";

      switch (after.status) {
        case "confirmed":
          title = "Booking Confirmed!";
          body = `${owner.name} confirmed your ${after.equipmentName} booking`;
          break;
        case "cancelled":
          title = "Booking Cancelled";
          body = `Your ${after.equipmentName} booking was cancelled`;
          break;
        case "active":
          title = "Rental Started";
          body = `Your ${after.equipmentName} rental is now active`;
          break;
        case "completed":
          title = "Rental Complete";
          body = `Your ${after.equipmentName} rental is complete. Please rate your experience!`;
          // Re-enable equipment availability
          await db.collection("equipment").doc(after.equipmentId).update({
            isAvailable: true,
          });
          break;
        default:
          return;
      }

      // Send FCM to renter
      if (renter.fcmToken) {
        await messaging.send({
          notification: { title, body },
          data: {
            type: "booking_update",
            bookingId: bookingId,
            status: after.status,
          },
          token: renter.fcmToken,
        });
      }

      // Send SMS to renter for confirmations
      if (after.status === "confirmed" && renter.phone && MSG91_AUTH_KEY !== "YOUR_MSG91_AUTH_KEY") {
        await sendSMS(
          renter.phone,
          MSG91_TEMPLATE_CONFIRM,
          {
            equipment: after.equipmentName,
            owner_name: owner.name,
            owner_phone: owner.phone || "",
            dates: `${after.startDate} to ${after.endDate}`,
            amount: `₹${after.totalAmount}`,
          }
        );
      }

    } catch (error) {
      console.error("Error in onBookingStatusChange:", error);
    }
  });

// ══════════════════════════════════════════════════════
// ══ FUNCTION 3: ON EQUIPMENT ADDED
// ══ Notify nearby renters when new equipment is listed
// ══════════════════════════════════════════════════════

exports.onEquipmentAdded = functions.firestore
  .document("equipment/{equipmentId}")
  .onCreate(async (snap, context) => {
    const equipment = snap.data();

    try {
      // Send topic notification to district subscribers
      const district = (equipment.district || "").replace(/\s+/g, "_").toLowerCase();
      if (!district) return;

      const topic = `district_${district}`;

      await messaging.send({
        notification: {
          title: "New Equipment Near You!",
          body: `${equipment.name} (${equipment.category}) now available in ${equipment.district}`,
        },
        data: {
          type: "new_equipment",
          equipmentId: context.params.equipmentId,
        },
        topic: topic,
      });

      console.log(`Topic notification sent: ${topic}`);
    } catch (error) {
      console.error("Error in onEquipmentAdded:", error);
    }
  });

// ══════════════════════════════════════════════════════
// ══ FUNCTION 4: DAILY BOOKING REMINDERS
// ══ Scheduled function — runs daily at 8 AM IST
// ══════════════════════════════════════════════════════

exports.dailyBookingReminders = functions.pubsub
  .schedule("0 8 * * *")
  .timeZone("Asia/Kolkata")
  .onRun(async (context) => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().split("T")[0];

    try {
      // Find bookings starting tomorrow
      const snapshot = await db.collection("bookings")
        .where("status", "==", "confirmed")
        .where("startDate", "==", tomorrowStr)
        .get();

      for (const doc of snapshot.docs) {
        const booking = doc.data();

        // Notify renter
        const renterDoc = await db.collection("users").doc(booking.renterId).get();
        if (renterDoc.exists && renterDoc.data().fcmToken) {
          await messaging.send({
            notification: {
              title: "Rental Tomorrow!",
              body: `Your ${booking.equipmentName} rental starts tomorrow`,
            },
            data: {
              type: "booking_reminder",
              bookingId: doc.id,
            },
            token: renterDoc.data().fcmToken,
          });
        }

        // Notify owner
        const ownerDoc = await db.collection("users").doc(booking.ownerId).get();
        if (ownerDoc.exists && ownerDoc.data().fcmToken) {
          await messaging.send({
            notification: {
              title: "Equipment Pickup Tomorrow",
              body: `${booking.equipmentName} pickup scheduled for tomorrow`,
            },
            data: {
              type: "booking_reminder",
              bookingId: doc.id,
            },
            token: ownerDoc.data().fcmToken,
          });
        }
      }

      console.log(`Sent ${snapshot.docs.length} reminder notifications`);
    } catch (error) {
      console.error("Error in dailyBookingReminders:", error);
    }
  });

// ══════════════════════════════════════════════════════
// ══ FUNCTION 5: PLATFORM STATS (HTTP callable)
// ══════════════════════════════════════════════════════

exports.getPlatformStats = functions.https.onCall(async (data, context) => {
  try {
    const equipmentCount = (await db.collection("equipment").get()).size;
    const userCount = (await db.collection("users").get()).size;
    const bookingCount = (await db.collection("bookings").get()).size;

    // Count unique districts
    const equipDocs = await db.collection("equipment").get();
    const districts = new Set();
    equipDocs.docs.forEach(doc => {
      if (doc.data().district) districts.add(doc.data().district);
    });

    return {
      totalEquipment: equipmentCount,
      totalFarmers: userCount,
      totalBookings: bookingCount,
      totalDistricts: districts.size,
    };
  } catch (error) {
    console.error("Error in getPlatformStats:", error);
    throw new functions.https.HttpsError("internal", "Failed to fetch stats");
  }
});

// ══════════════════════════════════════════════════════
// ══ FUNCTION 6: IVR WEBHOOK (Exotel / Feature Phones)
// ══ HTTP endpoint for feature phone farmer access
// ══════════════════════════════════════════════════════

exports.handleIvrCall = functions.https.onRequest(async (req, res) => {
  const step = req.query.step || "welcome";
  const language = req.query.lang || "tamil";
  const digit = req.body?.digits || req.query.digits || "";

  const langMap = { "1": "tamil", "2": "telugu", "3": "kannada", "4": "malayalam", "5": "hindi", "6": "english" };

  try {
    switch (step) {
      case "welcome":
        res.type("application/xml").send(`
          <Response>
            <Speak>Welcome to KrishiRent. கிரிஷி ரெண்ட்-க்கு வரவேற்கிறோம்.</Speak>
            <Gather numDigits="1" action="/handleIvrCall?step=language-selected" timeout="10">
              <Speak>Tamil press 1. Telugu press 2. Kannada press 3. Malayalam press 4. Hindi press 5. English press 6.</Speak>
            </Gather>
          </Response>
        `);
        break;

      case "language-selected": {
        const selectedLang = langMap[digit] || "english";
        res.type("application/xml").send(`
          <Response>
            <Gather numDigits="1" action="/handleIvrCall?step=action-selected&lang=${selectedLang}" timeout="10">
              <Speak>
                Equipment rental press 1. List your equipment press 2. Booking status press 3.
              </Speak>
            </Gather>
          </Response>
        `);
        break;
      }

      case "action-selected":
        if (digit === "3") {
          // Booking status — lookup by caller phone
          const callerPhone = req.body?.From || "";
          const bookings = await db.collection("bookings")
            .where("renterId", "==", callerPhone)
            .where("status", "in", ["pending", "confirmed", "active"])
            .limit(3)
            .get();

          let statusMsg = "No active bookings found.";
          if (!bookings.empty) {
            statusMsg = `You have ${bookings.size} active bookings. `;
            const first = bookings.docs[0].data();
            statusMsg += `Latest: ${first.equipmentName}, status ${first.status}.`;
          }

          res.type("application/xml").send(`
            <Response>
              <Speak>${statusMsg}</Speak>
              <Speak>Thank you for calling KrishiRent. Goodbye.</Speak>
              <Hangup />
            </Response>
          `);
        } else {
          res.type("application/xml").send(`
            <Response>
              <Speak>This feature is coming soon. Thank you for calling KrishiRent.</Speak>
              <Hangup />
            </Response>
          `);
        }
        break;

      default:
        res.type("application/xml").send(`
          <Response>
            <Speak>Thank you for calling KrishiRent. Goodbye.</Speak>
            <Hangup />
          </Response>
        `);
    }
  } catch (error) {
    console.error("IVR error:", error);
    res.type("application/xml").send(`
      <Response>
        <Speak>Sorry, an error occurred. Please try again later.</Speak>
        <Hangup />
      </Response>
    `);
  }
});

// ══════════════════════════════════════════════════════
// ══ SMS HELPER (MSG91 API)
// ══════════════════════════════════════════════════════

async function sendSMS(phone, templateId, variables) {
  try {
    const response = await axios.post(
      "https://control.msg91.com/api/v5/flow/",
      {
        template_id: templateId,
        short_url: "0",
        recipients: [
          {
            mobiles: phone.replace("+", ""),
            ...variables,
          },
        ],
      },
      {
        headers: {
          "authkey": MSG91_AUTH_KEY,
          "Content-Type": "application/json",
        },
      }
    );

    console.log(`MSG91 SMS response: ${response.data.type}`);
    return response.data;
  } catch (error) {
    console.error("MSG91 SMS error:", error.response?.data || error.message);
  }
}
