/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 */
define(['N/https', 'N/log', 'N/runtime', 'N/query'], (https, log, runtime, query) => {

    /**
     * Helper to resolve address details of a location using SuiteQL.
     */
    const getLocationAddress = (locationId) => {
        const address = {
    addressee: "",
    addressLine1: "",
    addressLine2: "",
    city: "",
    state: "",
    postalCode: "",
    country: "US",
    latitude: 0,
    longitude: 0,
    locationId: ""
};
        if (!locationId) return address;
        try {
const lookupRes = query.runSuiteQL({
    query: `
        SELECT
            lm.name AS location_id,
            lm.custrecord_ft_wmdc_location_name AS addressee,
            lm.custrecord_ft_wmdc_location_address AS addr1,
            '' AS addr2,
            lm.custrecord_ft_wmdc_location_city AS city,
            BUILTIN.DF(lm.custrecord_ft_wmdc_location_state) AS state,
            lm.custrecord_ft_wmdc_location_zip AS zip,
            'US' AS country,
            lm.custrecord_ft_wmdc_location_latitude AS latitude,
            lm.custrecord_ft_wmdc_location_longitude AS longitude
        FROM
            customrecord_ft_location_master lm
        WHERE
            lm.id = ?
    `,
    params: [locationId]
}).asMappedResults();

            if (lookupRes && lookupRes.length > 0) {
                const lookup = lookupRes[0];
address.addressee = lookup.addressee || "";
address.addressLine1 = lookup.addr1 || "";
address.addressLine2 = lookup.addr2 || "";
address.city = lookup.city || "";
address.state = lookup.state || "";
address.postalCode = lookup.zip || "";
address.country = lookup.country || "US";
address.latitude = parseFloat(lookup.latitude) || 0;
address.longitude = parseFloat(lookup.longitude) || 0;
address.locationId = lookup.location_id || "";
            }
        } catch (e) {
            log.error('Error looking up location address via SuiteQL', e.message || e.toString());
        }
        return address;
    };

    /**
     * Helper to parse NetSuite Date/Time/Date values.
     */
    const parseNsDate = (dateVal) => {
        if (!dateVal) return null;
        try {
            if (dateVal instanceof Date) return dateVal;
            const parsed = new Date(dateVal);
            if (!isNaN(parsed.getTime())) return parsed;
        } catch (e) {
            log.error('Error parsing date: ' + dateVal, e.message || e.toString());
        }
        return null;
    };

    /**
     * Helper to format Date object into local ISO-8601 string without timezone (e.g. YYYY-MM-DDTHH:mm:ss).
     */
    const formatIsoDateTime = (date) => {
        if (!date) return "";
        const pad = (num) => String(num).padStart(2, '0');
        return date.getFullYear() + '-' +
            pad(date.getMonth() + 1) + '-' +
            pad(date.getDate()) + 'T' +
            pad(date.getHours()) + ':' +
            pad(date.getMinutes()) + ':' +
            pad(date.getSeconds());
    };

    /**
     * Marks the beginning of the Map/Reduce process.
     * Uses SuiteQL to run query on GRS records, groups them in memory, and returns the constructed payload array.
     */
    const getInputData = () => {
        log.audit('getInputData', 'Initializing data payload from SuiteQL query...');
        try {
            const sql = `
                SELECT 
                    g.id,
                    g.name,
                    g.custrecord_ft_quedns_reqid,
                    g.custrecord_ft_pool,
                    g.custrecord_ft_dc,
                    g.custrecord_ft_truck,
                    g.custrecord_ft_vendor_number,
                    g.custrecord_ft_vendor,
                    c.entityid AS vendor_entity_id,
                    c.companyname AS vendor_name,
                    g.custrecord_ft_department,
                    g.custrecord_ft_item_number,
                    g.custrecord_ft_item_description,
                    g.custrecord_ft_order_quantity,
                    g.custrecord_ft_weight_quantity,
                    g.custrecord_ft_cube_quantity,
                    g.custrecord_ft_mabd,
                    g.custrecord_ft_purchase_order_type,
                    g.custrecord_ft_adj_mabd,
                    g.custrecord_ft_grs_location,
                    g.custrecord_appointment_datetime,
                    g.custrecord_ft_grs_origappt_dateunavail,
                    g.custrecord_no_appointments_available,
                    g.custrecord_sail_record,
                    g.custrecord_po_numbers,
                    g.custrecord_ft_po_quantity_payload
                FROM 
                    customrecord_ft_walmart_grs g
                LEFT JOIN 
                    customer c ON g.custrecord_ft_vendor = c.id
                WHERE 
                    (g.custrecord_qued_appt_number IS NULL OR g.custrecord_qued_appt_number = '')
                    AND g.custrecord_ft_quedns_reqid IS NOT NULL
                    AND TRUNC(g.created) = TRUNC(CURRENT_DATE)
                    AND LENGTH(g.name) > 17
                    AND g.custrecord_appointment_record_type != 2
                    
                 `;
                    // AND g.id IN ('4489288') 
                    // AND (g.custrecord_no_appointments_available IS NULL OR g.custrecord_no_appointments_available = 'F')
                    // AND (g.custrecord_ft_grs_origappt_dateunavail IS NULL OR g.custrecord_ft_grs_origappt_dateunavail = 'F')

            const queryResults = query.runSuiteQL({ query: sql }).asMappedResults();
            log.audit('getInputData', `Found ${queryResults.length} GRS records.`);
            if (queryResults.length === 0) {
                return [];
            }

            // Group GRS records by QUED Request ID to create the payload(s).
            const groups = {};
            queryResults.forEach(result => {
                const apptId = result.custrecord_ft_quedns_reqid;
                const internalId = result.id;

                const groupKey = apptId || internalId;
                if (!groups[groupKey]) {
                    groups[groupKey] = [];
                }
                groups[groupKey].push(result);
            });

            const payloads = [];
            for (const groupKey in groups) {
                if (!groups.hasOwnProperty(groupKey)) continue;
                const records = groups[groupKey];
                const primaryRec = records[0];

                // Get Destination/DC Location details, fallback to Warehouse
const dcLocId = primaryRec.custrecord_ft_dc;
const grsLocId = primaryRec.custrecord_ft_grs_location;

// Internal ID used to find customrecord_ft_location_master
const finalLocId = dcLocId || grsLocId;

const locAddress = getLocationAddress(finalLocId);

// This is customrecord_ft_location_master.name, example WALMAR32615
const finalLocName = locAddress.locationId || '';

const stopLocName = locAddress.addressee || finalLocName || '';

                // Determine schedule range start & end
                let apptDate = parseNsDate(primaryRec.custrecord_appointment_datetime);
                let startStr = "";
                let endStr = "";
                if (apptDate) {
                    startStr = formatIsoDateTime(apptDate);
                    const endDate = new Date(apptDate.getTime() + 90 * 60 * 1000); // +1.5 hours
                    endStr = formatIsoDateTime(endDate);
                } else {
                    let fallbackDate = parseNsDate(primaryRec.custrecord_ft_adj_mabd) || parseNsDate(primaryRec.custrecord_ft_mabd);
                    if (fallbackDate) {
                        const startDate = new Date(fallbackDate);
                        startDate.setHours(8, 0, 0, 0);
                        const endDate = new Date(fallbackDate);
                        endDate.setHours(17, 0, 0, 0);
                        startStr = formatIsoDateTime(startDate);
                        endStr = formatIsoDateTime(endDate);
                    } else {
                        const now = new Date();
                        now.setHours(12, 0, 0, 0);
                        startStr = formatIsoDateTime(now);
                        const end = new Date(now.getTime() + 90 * 60 * 1000);
                        endStr = formatIsoDateTime(end);
                    }
                }

                // Construct stops array
                const stops = records.map((rec, index) => {
                    const proNum = rec.id || "";
                    const custId = rec.vendor_entity_id || rec.custrecord_ft_vendor_number || rec.custrecord_ft_vendor || "";
                    const custName = rec.vendor_name || rec.custrecord_ft_vendor || "";
                    const itemNum = rec.custrecord_ft_item_number || "";
                    const itemDesc = rec.custrecord_ft_item_description || "";

                    let poValues = [];
                    if (rec.custrecord_po_numbers) {
                        poValues = rec.custrecord_po_numbers.split(',').map(item => item.trim()).filter(Boolean);
                    }
                    if (poValues.length === 0) {
                        poValues = [rec.name || rec.id || "N/A"];
                    }

                    const cubeVal = parseFloat(rec.custrecord_ft_cube_quantity);
                    const pallets = isNaN(cubeVal) || cubeVal <= 0 ? 1 : cubeVal;
                    const qtyVal = parseInt(rec.custrecord_ft_order_quantity);
                    const pieces = isNaN(qtyVal) || qtyVal <= 0 ? 1 : qtyVal;
                    const wtVal = parseFloat(rec.custrecord_ft_weight_quantity);
                    const weight = isNaN(wtVal) ? 0 : wtVal;
                    const poPayload = JSON.parse(rec.custrecord_ft_po_quantity_payload || '[]');


                  const referenceNumbers = poValues.map((po, idx) => {
                      const poQty = poPayload.find(p => String(p.po) === String(po));

                      return {
                          "type": "PO",
                          "description": "Purchase Order",
                          "value": po,
                          "pallets": poQty ? poQty.cubeQty : (idx === 0 ? pallets : 0),
                          "pieces": poQty ? poQty.orderQty : (idx === 0 ? pieces : 0),
                          "weightInLbs": poQty ? poQty.weightQty : (idx === 0 ? weight : 0)
                      };
                 });
                  
                    // const referenceNumbers = poValues.map((po, idx) => ({
                    //     "type": "PO",
                    //     "description": "Purchase Order",
                    //     "value": po,
                    //     "pallets": idx === 0 ? pallets : 0,
                    //     "pieces": idx === 0 ? pieces : 0,
                    //     "weightInLbs": idx === 0 ? weight : 0
                    // }));

                    return {
                        "proNumber": String(proNum),
                        "stopSequenceNumber": index + 1,
                        "customerId": String(custId),
                        "customerName": custName,
                        "commodityId": itemNum,
                        "commodityName": itemDesc,
                        "referenceNumbers": referenceNumbers
                    };
                });

                const payload = {
                    "appointmentId": groupKey,
                    "stops": stops,
                    "stopType": "DELIVER",
                   // "stopLocationId": finalLocName,
                    //"stopLocationName": "Walmart Distribution Center - 80538",
                     "stopLocationId": finalLocName,
                     "stopLocationName": stopLocName,
                    "locationAddress": {
                        "addressLine1": locAddress.addressLine1 || "100 PARAGON PKWY",
                        "addressLine2": locAddress.addressLine2 || "",
                        "city": locAddress.city || "MANSFIELD",
                        "state": locAddress.state || "OH",
                        "postalCode": locAddress.postalCode || "44903",
                        "country": locAddress.country || "US",
                        "latitude": locAddress.latitude || 0,
                        "longitude": locAddress.longitude || 0
                    },
                    "equipmentType": "",
                    "maxTemperature": 0,
                    "trailerId": primaryRec.custrecord_ft_truck || "",
                    "loadingType": "LIVE",
                    "apptSchdRangeStart": startStr,
                    "apptSchdRangeEnd": endStr,
                    "appointmentContact": {
                        "schedulingType": "PORTAL",
                        "stopType": "DELIVERY",
                        "phone": {},
                        "portal": {
                            "url": "https://warehouse-portal.com/book",
                            "additionalInfo": {
                                "OPENDOCK": {}
                            }
                        },
                        "addQuestions": false
                    },
                    "notificationEmails": []
                };

                payloads.push(payload);
            }

            log.audit('getInputData', `Generated ${payloads.length} payloads.`);
            return payloads;

        } catch (e) {
            log.error('getInputData Error', e.message || e.toString());
            return [];
        }
    };

    /**
     * Map stage: Performs the HTTPS POST request to create the appointment.
     */
    const map = (context) => {
        try {
            log.audit('map', 'Started processing key: ' + context.key);
            const shipment = JSON.parse(context.value);

            log.debug('payload', shipment);

            const url = runtime.getCurrentScript().getParameter({ name: 'custscript_schedule_appointment_url' }) || 'https://uat1-appt-api.qued.com/estes/appointments/schedule-appointment';
            // Reschedule endpoint configuration (not in execution, ready for future use)
            const rescheduleUrl = runtime.getCurrentScript().getParameter({ name: 'custscript_reschedule_appointment_url' }) || 'https://uat1-appt-api.qued.com/estes/appointments/reschedule-appointment';

            const headers = {
                'Content-Type': 'application/json',
                'x-api-key': https.createSecureString({ input: '{custsecret_qued_api_key}' })
            };

            log.audit('map', `Sending POST request to ${url} for appointment ID: ${shipment.appointmentId}`);

            const response = https.post({
                url: url,
                headers: headers,
                body: JSON.stringify(shipment)
            });

            /*
            // Future Use: Reschedule request execution (commented out as per requirements)
            log.audit('map', `Sending Reschedule POST request to ${rescheduleUrl} for appointment ID: ${shipment.appointmentId}`);
            const rescheduleResponse = https.post({
                url: rescheduleUrl,
                headers: headers,
                body: JSON.stringify(shipment)
            });
            log.audit('map', `Reschedule response code: ${rescheduleResponse.code}`);
            log.audit('map', `Reschedule response body: ${rescheduleResponse.body}`);
            */

            log.audit('map', `Response code: ${response.code}`);
            log.audit('map', `Response body: ${response.body}`);

            context.write({
                key: shipment.appointmentId || context.key,
                value: {
                    success: response.code === 200 || response.code === 202,
                    code: response.code,
                    body: response.body
                }
            });

        } catch (e) {
            log.error('map', `Error processing key ${context.key}: ${e.message || e.toString()}`);
            context.write({
                key: context.key,
                value: {
                    success: false,
                    error: e.message || e.toString()
                }
            });
        }
    };

    /**
     * Reduce stage: Standard pass-through or basic logging.
     */
    const reduce = (context) => {
        try {
            log.audit('reduce', `Reducing key: ${context.key}`);
            context.values.forEach(val => {
                context.write({
                    key: context.key,
                    value: val
                });
            });
        } catch (e) {
            log.error('reduce', `Error in reduce stage: ${e.message || e.toString()}`);
        }
    };

    /**
     * Summarize stage: Summarizes the Map/Reduce execution and logs final metrics.
     */
    const summarize = (summary) => {
        log.audit('summarize', 'Map/Reduce script execution complete.');

        let successCount = 0;
        let failureCount = 0;

        summary.output.iterator().each((key, value) => {
            try {
                const parsedVal = JSON.parse(value);
                log.debug('parsedVal', parsedVal);

                if (parsedVal.success) {
                    successCount++;
                    log.audit('summarize', `Appointment ID ${key} created successfully. Response: ${parsedVal.body}`);
                } else {
                    failureCount++;
                    log.error('summarize', `Appointment ID ${key} failed. Details: ${parsedVal.error || parsedVal.body}`);
                }
            } catch (e) {
                log.error('summarize', `Error parsing output for key ${key}: ${e.message || e.toString()}`);
            }
            return true;
        });

        log.audit('summarize', `Summary metrics: Successes = ${successCount}, Failures = ${failureCount}`);

        if (summary.inputSummary.error) {
            log.error('summarize', `Input Stage Error: ${summary.inputSummary.error}`);
        }

        summary.mapSummary.errors.iterator().each((key, error) => {
            log.error('summarize', `Map Error for Key ${key}: ${error}`);
            return true;
        });

        summary.reduceSummary.errors.iterator().each((key, error) => {
            log.error('summarize', `Reduce Error for Key ${key}: ${error}`);
            return true;
        });
    };

    return {
        getInputData,
        map,
        reduce,
        summarize
    };
});
