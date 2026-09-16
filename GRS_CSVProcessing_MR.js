/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 * @NModuleScope SameAccount
 *
 * GRS_CSVProcessing_MR.js
 *
 * Purpose:
 *   Reads Walmart GRS CSV files from a "Pending" File Cabinet folder, groups rows by
 *   POOL + DC + VENDOR_NBR + MABD, creates one customrecord_ft_walmart_grs record per
 *   group (comma-separated PO list, summed ORDER_QTY/WEIGHT_QTY/CUBE_QTY, customer looked
 *   up via custentity_ft_vendor_number), then moves the source file to "Processed".
 *
 *   In addition to the per-customer "Initial Request" record, this script also rolls
 *   those groups up (within the same file) by POOL + DC + MABD only - across whichever
 *   customers/vendors share that key - and creates ONE "Consolidated Request" record
 *   for each such rollup, with PO lists comma-joined and quantities summed the same way.
 *   Both record types live on customrecord_ft_walmart_grs and are distinguished only by
 *   custrecord_appointment_record_type (1 = Initial Request, 2 = Consolidated Request).
 *   The consolidated record intentionally leaves custrecord_ft_vendor and
 *   custrecord_ft_vendor_number blank, since it can span multiple customers.
 *
 *   Governance design: map() only parses the CSV and builds groups (cheap - no
 *   searches or creates). Each group - both the per-customer "initial" groups and the
 *   per-file "consolidated" rollups - is emitted with its own compound key
 *   (fileId::groupKey or fileId::CONSOLIDATED::rollupKey), so every group gets its OWN
 *   reduce() invocation with a fresh governance allowance - all the customer/DC/pool/sail
 *   lookups plus the record create happen there, one group at a time. This is what keeps
 *   a large CSV (many groups) from stacking enough governance-costed operations into a
 *   single execution to trip "Script Execution Usage Limit Exceeded". summarize() then
 *   does the lightweight per-file wrap-up: building an error CSV for any failed groups
 *   and moving the original file to Processed or Error.
 *
 *   Customer/DC/Pool/Sail-record lookups are best-effort: if a match isn't found, that
 *   particular field is simply left blank on the record rather than failing the group.
 *   A group only lands in the error CSV if the record.create()/save() call itself throws.
 *
 *   If a file itself cannot be parsed (missing/garbled headers, empty file, etc.) the
 *   ENTIRE original file is moved to the Error folder instead of Processed.
 */
define(['N/file', 'N/log', 'N/record', 'N/search', 'N/format', 'N/runtime', 'N/task'],
    (file, log, record, search, format, runtime, task) => {

        // =========================================================================
        // CONFIG - replace with your actual File Cabinet folder internal IDs
        // =========================================================================
        const PENDING_FOLDER_ID = 2486833;  // Pending
        const PROCESSED_FOLDER_ID = 2486835;  // Processed
        const ERROR_FOLDER_ID = 2486834;  // Errored

        const CUSTOM_RECORD_TYPE = 'customrecord_ft_walmart_grs';
        const CUSTOMER_VENDOR_NBR_FIELD = 'custentity_ft_vendor_number';

        const LOCATION_MASTER_RECORD_TYPE = 'customrecord_ft_location_master';
        const LOCATION_MASTER_DC_NBR_FIELD = 'custrecord_ft_wmdc_number';

        const POOL_MAPPING_RECORD_TYPE = 'customrecord_ft_walmart_grs_mapping';
        const POOL_MAPPING_POOL_FIELD = 'custrecord_ft_wmgrsmap_pool';

        const SAIL_RECORD_TYPE = 'customrecord_ft_walmart_saildates_dcloc';
        const SAIL_RECORD_DC_FIELD = 'custrecord_ft_wmsail_dc';
        const SAIL_RECORD_POOL_FIELD = 'custrecord_ft_walmart_pool';
        const SAIL_RECORD_FUSION_WAREHOUSE_FIELD = 'custrecord_ft_wmsail_fusion_warehouse';
        const SAIL_RECORD_MABD_DOW_FIELD = 'custrecord_ft_wmsail_mabd';

        // Distinguishes an "Initial Request" (per-customer) record from a "Consolidated
        // Request" (per POOL_DC_MABD rollup across customers) record on
        // customrecord_ft_walmart_grs. Both record types share every other field.
        const APPOINTMENT_RECORD_TYPE_FIELD = 'custrecord_appointment_record_type';
        const RECORD_TYPE_INITIAL = 1;      // "Initial Request"
        const RECORD_TYPE_CONSOLIDATED = 2; // "Consolidated Request"

        // Cache of DC number -> location master internal id, populated per map() invocation
        // so repeated groups sharing the same DC don't each trigger a fresh search.
        const dcLookupCache = {};

        // Cache of POOL number -> grs mapping internal id, populated per map() invocation
        // so repeated groups sharing the same POOL don't each trigger a fresh search.
        const poolLookupCache = {};

        // Cache of "locationMasterId|poolMappingId" -> sail record internal id.
        const sailLookupCache = {};

        // Cache of VENDOR_NBR -> customer internal id (or null if no match), populated
        // once per unique vendor number encountered across map() invocations. This lets
        // multiple vendor numbers that belong to the same NetSuite customer collapse
        // into one GRS group instead of one group per raw vendor number.
        const vendorCustomerCache = {};

        // Required CSV headers, in the order we expect them (order itself doesn't matter,
        // we map by header name - but all of these must be present)
        const REQUIRED_HEADERS = [
            'POOL', 'DC', 'TRUCK', 'PO', 'VENDOR_NBR', 'VENDOR_NAME',
            'DEPT', 'ITEM_NBR', 'ITEM_DESC', 'ORDER_QTY', 'WEIGHT_QTY',
            'CUBE_QTY', 'MABD', 'PO_TYPE'
        ];

        // =========================================================================
        // getInputData - find all CSV files sitting in the Pending folder
        // =========================================================================
        const getInputData = (inputContext) => {
            try {
                const fileSearch = search.create({
                    type: 'file',
                    filters: [
                        ['folder', 'anyof', PENDING_FOLDER_ID],
                        'AND',
                        ['filetype', 'anyof', 'CSV']
                    ],
                    columns: ['name']
                });

                const fileIds = [];
                fileSearch.run().each((result) => {
                    fileIds.push(result.id);
                    return true; // keep iterating
                });

                log.audit('getInputData', `Found ${fileIds.length} CSV file(s) in Pending folder`);
                return fileIds;
            } catch (e) {
                log.error('getInputData error', e);
                throw e;
            }
        };

        // =========================================================================
        // map - one invocation per file: parse + group only (cheap - no searches/creates
        // here). Emits ONE key per initial (per-customer) group, PLUS one key per
        // consolidated (POOL_DC_MABD) rollup group for the same file, so each still gets
        // its own reduce() invocation with a fresh governance allowance.
        // =========================================================================
        const map = (mapContext) => {
            const fileId = mapContext.value;
            let grsFile;

            try {
                grsFile = file.load({ id: fileId });
            } catch (e) {
                log.error(`map - unable to load file ${fileId}`, e);
                mapContext.write({ key: `${fileId}::__FATAL__`, value: JSON.stringify({ fileId, status: 'fatal', error: e.message }) });
                return;
            }

            let rows;
            try {
                rows = parseCsv(grsFile.getContents());
                validateHeaders(rows.headerRow);
            } catch (e) {
                log.error(`map - unable to parse file ${grsFile.name} (${fileId})`, e);
                mapContext.write({ key: `${fileId}::__FATAL__`, value: JSON.stringify({ fileId, status: 'fatal', error: e.message }) });
                return;
            }

            const vendorNbrs = uniqueVendorNbrs(rows.dataRows, rows.headerIndex);
            const vendorCustomerMap = lookupCustomerIdsForVendorNbrs(vendorNbrs);

            const groups = groupRows(rows.dataRows, rows.headerIndex, vendorCustomerMap);

            Object.keys(groups).forEach((groupKey) => {
                mapContext.write({
                    key: `${fileId}::${groupKey}`,
                    value: JSON.stringify({
                        fileId,
                        groupKey,
                        type: 'initial',
                        headerRow: rows.headerRow,
                        group: groups[groupKey]
                    })
                });
            });

            // Roll the same file's groups up by POOL_DC_MABD only (across whichever
            // customers/vendors share that key) and emit one consolidated group per
            // rollup. The "CONSOLIDATED::" key segment keeps these from ever colliding
            // with an initial group's key.
            const consolidatedGroups = buildConsolidatedGroups(groups);

            Object.keys(consolidatedGroups).forEach((rollupKey) => {
                mapContext.write({
                    key: `${fileId}::CONSOLIDATED::${rollupKey}`,
                    value: JSON.stringify({
                        fileId,
                        groupKey: rollupKey,
                        type: 'consolidated',
                        headerRow: rows.headerRow,
                        group: consolidatedGroups[rollupKey]
                    })
                });
            });
        };

        // =========================================================================
        // reduce - one invocation per GROUP (compound key = fileId::groupKey, or
        // fileId::CONSOLIDATED::rollupKey). All the lookups + the record create happen
        // here, one group at a time, so each call gets its own governance allowance
        // instead of stacking every group in a file into one execution.
        // =========================================================================
        const reduce = (reduceContext) => {
            const entry = JSON.parse(reduceContext.values[0]);

            if (entry.status === 'fatal') {
                // File-level parse failure - just pass it through for summarize to handle.
                reduceContext.write({ key: entry.fileId, value: JSON.stringify(entry) });
                return;
            }

            const { fileId, groupKey, headerRow, group, type } = entry;
            const isConsolidated = type === 'consolidated';
            const recordTypeValue = isConsolidated ? RECORD_TYPE_CONSOLIDATED : RECORD_TYPE_INITIAL;

            try {
                if (!isConsolidated && !group.customerId) {
                    log.audit(`reduce - no customer found for VENDOR_NBR(s) ${group.vendorNbrs.join(', ')}`, `group ${groupKey} - custrecord_ft_vendor left blank`);
                }

                const recId = createGrsRecord(group, recordTypeValue, isConsolidated);

                reduceContext.write({
                    key: fileId,
                    value: JSON.stringify({ status: 'success', groupKey, type, recordId: recId })
                });
            } catch (e) {
                log.error(`reduce - group failed [${groupKey}] in file ${fileId}`, e);
                reduceContext.write({
                    key: fileId,
                    value: JSON.stringify({
                        status: 'error',
                        groupKey,
                        type,
                        error: e.message,
                        headerRow,
                        rows: group.rawRows
                    })
                });
            }
        };

        // =========================================================================
        // summarize - one execution total: aggregates every reduce() output by fileId,
        // builds the per-file error CSV (if needed), and moves each source file to
        // Processed or Error. Cheap regardless of file size - just file cabinet ops,
        // one per source file.
        // =========================================================================
        const summarize = (summaryContext) => {
            const byFile = {};
            let totalSuccesses = 0;

            summaryContext.output.iterator().each((fileId, value) => {
                const entry = JSON.parse(value);
                if (!byFile[fileId]) byFile[fileId] = [];
                byFile[fileId].push(entry);
                return true;
            });

            Object.keys(byFile).forEach((fileId) => {
                const entries = byFile[fileId];

                let grsFile;
                try {
                    grsFile = file.load({ id: fileId });
                } catch (e) {
                    log.error(`summarize - unable to load file ${fileId} for final move`, e);
                    return;
                }

                const fatal = entries.filter((e) => e.status === 'fatal');
                if (fatal.length > 0) {
                    moveFile(grsFile, ERROR_FOLDER_ID);
                    log.error(`summarize - file ${grsFile.name} unparseable, moved to Error folder`, fatal[0].error);
                    return;
                }

                const errors = entries.filter((e) => e.status === 'error');
                const successes = entries.filter((e) => e.status === 'success');
                totalSuccesses += successes.length;

                if (errors.length > 0) {
                    writeErrorCsv(grsFile, errors);
                }

                // Original file moves to Processed once all groups have been attempted -
                // failed groups already have their own dedicated CSV in the Error folder.
                moveFile(grsFile, PROCESSED_FOLDER_ID);

                const initialSuccesses = successes.filter((e) => e.type !== 'consolidated').length;
                const consolidatedSuccesses = successes.filter((e) => e.type === 'consolidated').length;

                log.audit(`summarize - file ${grsFile.name} complete`,
                    `${initialSuccesses} initial record(s), ${consolidatedSuccesses} consolidated record(s) created, ${errors.length} group(s) failed`);
            });

            let mapErrors = 0;
            summaryContext.mapSummary.errors.iterator().each((key, error) => {
                mapErrors++;
                log.error(`Map error on key ${key}`, error);
                return true;
            });

            let reduceErrors = 0;
            summaryContext.reduceSummary.errors.iterator().each((key, error) => {
                reduceErrors++;
                log.error(`Reduce error on key ${key}`, error);
                return true;
            });

            log.audit('summarize', `Usage: ${summaryContext.usage} | Concurrency: ${summaryContext.concurrency} `
                + `| Yields: ${summaryContext.yields} | Map errors: ${mapErrors} | Reduce errors: ${reduceErrors}`);

            // Schedule the Qued Appointment Map/Reduce Script if new GRS records were created
            if (totalSuccesses > 0) {
                try {
                    const scriptObj = runtime.getCurrentScript();
                    const apptScriptId = scriptObj.getParameter({ name: 'custscript_qued_appt_script_id' }) || 'customscript_ft_qued_appointment_mr';
                    const apptDeployId = scriptObj.getParameter({ name: 'custscript_qued_appt_deploy_id' }) || 'customdeploy_ft_qued_appointment_mr';

                    log.audit('summarize', `Scheduling Qued Appointment Map/Reduce Script: ${apptScriptId} (Deployment: ${apptDeployId || 'Default'})`);

                    const taskParams = {
                        taskType: task.TaskType.MAP_REDUCE,
                        scriptId: apptScriptId
                    };
                    if (apptDeployId) {
                        taskParams.deploymentId = apptDeployId;
                    }

                    const mrTask = task.create(taskParams);
                    const mrTaskId = mrTask.submit();
                    log.audit('summarize', `Qued Appointment Map/Reduce Task submitted successfully. Task ID: ${mrTaskId}`);
                } catch (taskError) {
                    log.error('summarize - failed to schedule appointment MR', taskError.message || taskError.toString());
                }
            } else {
                log.audit('summarize', 'No GRS records were created; skipping Qued Appointment Map/Reduce script scheduling.');
            }
        };


        // =========================================================================
        // Helpers
        // =========================================================================

        /**
         * Parses raw CSV text into a header row + data rows, handling quoted fields
         * that may contain embedded commas (e.g. "ASUS 14"" ZEN OLED R7").
         */
        function parseCsv(contents) {
            const lines = contents
                .replace(/\r\n/g, '\n')
                .replace(/\r/g, '\n')
                .split('\n')
                .filter((line) => line.trim().length > 0);

            if (lines.length < 2) {
                throw new Error('File has no data rows (needs a header row plus at least one data row)');
            }

            const headerRow = parseCsvLine(lines[0]).map((h) => h.trim().replace(/^\uFEFF/, ''));
            const headerIndex = {};
            headerRow.forEach((h, i) => { headerIndex[h] = i; });

            const dataRows = lines.slice(1).map((line) => parseCsvLine(line));

            return { headerRow, headerIndex, dataRows };
        }

        /** Splits a single CSV line into fields, respecting double-quoted values. */
        function parseCsvLine(line) {
            const fields = [];
            let cur = '';
            let inQuotes = false;

            for (let i = 0; i < line.length; i++) {
                const ch = line[i];
                if (inQuotes) {
                    if (ch === '"') {
                        if (line[i + 1] === '"') { cur += '"'; i++; }
                        else { inQuotes = false; }
                    } else {
                        cur += ch;
                    }
                } else {
                    if (ch === '"') { inQuotes = true; }
                    else if (ch === ',') { fields.push(cur); cur = ''; }
                    else { cur += ch; }
                }
            }
            fields.push(cur);
            return fields;
        }

        function validateHeaders(headerRow) {
            const missing = REQUIRED_HEADERS.filter((h) => headerRow.indexOf(h) === -1);
            if (missing.length > 0) {
                throw new Error(`Missing required column(s): ${missing.join(', ')}`);
            }
        }

        /**
         * Groups data rows by POOL + DC + (resolved customer) + MABD, summing quantities
         * and collecting PO numbers, TRUCK numbers, and raw VENDOR_NBR values along the
         * way.
         *
         * Grouping is keyed on the CUSTOMER the vendor number resolves to (via
         * vendorCustomerMap), not the raw VENDOR_NBR string. This is what lets a file
         * that sends several different vendor numbers for the same NetSuite customer
         * (e.g. 737770193 / 737770140 / 737770030 all mapping to one customer) collapse
         * into a single GRS record instead of one per vendor number. Rows whose vendor
         * number doesn't resolve to any customer still get their own group (keyed off
         * the raw vendor number) so they don't get merged with unrelated rows.
         */
        function groupRows(dataRows, headerIndex, vendorCustomerMap) {
            const groups = {};

            dataRows.forEach((row) => {
                const pool = (row[headerIndex.POOL] || '').trim();
                const dc = (row[headerIndex.DC] || '').trim();
                const truck = (row[headerIndex.TRUCK] || '').trim();
                const vendorNbr = (row[headerIndex.VENDOR_NBR] || '').trim();
                const mabd = (row[headerIndex.MABD] || '').trim();
                const po = (row[headerIndex.PO] || '').trim();

                const orderQty = parseFloat(row[headerIndex.ORDER_QTY]) || 0;
                const weightQty = parseFloat(row[headerIndex.WEIGHT_QTY]) || 0;
                const cubeQty = parseFloat(row[headerIndex.CUBE_QTY]) || 0;

                const customerId = vendorCustomerMap[vendorNbr] || null;
                // Fall back to grouping by the raw vendor number only when no customer
                // match exists, so unmatched rows don't collide with each other.
                const customerKey = customerId || `UNMATCHED_${vendorNbr}`;
                const groupKey = `${pool}_${dc}_${customerKey}_${mabd}`;

                if (!groups[groupKey]) {
                    groups[groupKey] = {
                        pool, dc, mabd,
                        customerId,
                        vendorNbrs: [],
                        poNumbers: [],
                        truckNumbers: [],
                        orderQty: 0,
                        weightQty: 0,
                        cubeQty: 0,
                        rawRows: []
                    };
                }

                const g = groups[groupKey];
                if (vendorNbr && g.vendorNbrs.indexOf(vendorNbr) === -1) g.vendorNbrs.push(vendorNbr);
                if (po && g.poNumbers.indexOf(po) === -1) g.poNumbers.push(po);
                if (truck && g.truckNumbers.indexOf(truck) === -1) g.truckNumbers.push(truck);
                g.orderQty += orderQty;
                g.weightQty += weightQty;
                g.cubeQty += cubeQty;
                g.rawRows.push(row);
            });

            return groups;
        }

        /**
         * Rolls the per-customer groups produced by groupRows() up by POOL_DC_MABD only,
         * across whichever customers/vendors share that key within this same file. Used
         * to build the "Consolidated Request" record for each POOL/DC/MABD combination -
         * PO numbers and TRUCK numbers are unioned (deduped), and ORDER_QTY/WEIGHT_QTY/
         * CUBE_QTY are summed across every contributing group, mirroring groupRows()'s
         * own aggregation. Deliberately carries no customerId/vendorNbrs forward, since
         * a rollup can span multiple customers and those fields are left blank on the
         * consolidated record.
         */
        function buildConsolidatedGroups(groups) {
            const consolidated = {};

            Object.keys(groups).forEach((key) => {
                const g = groups[key];
                const rollupKey = `${g.pool}_${g.dc}_${g.mabd}`;

                if (!consolidated[rollupKey]) {
                    consolidated[rollupKey] = {
                        pool: g.pool, dc: g.dc, mabd: g.mabd,
                        poNumbers: [],
                        truckNumbers: [],
                        orderQty: 0,
                        weightQty: 0,
                        cubeQty: 0,
                        rawRows: []
                    };
                }

                const c = consolidated[rollupKey];
                g.poNumbers.forEach((po) => { if (c.poNumbers.indexOf(po) === -1) c.poNumbers.push(po); });
                g.truckNumbers.forEach((t) => { if (c.truckNumbers.indexOf(t) === -1) c.truckNumbers.push(t); });
                c.orderQty += g.orderQty;
                c.weightQty += g.weightQty;
                c.cubeQty += g.cubeQty;
                c.rawRows.push(...g.rawRows);
            });

            return consolidated;
        }

        /** Returns the distinct, non-blank VENDOR_NBR values present in a file. */
        function uniqueVendorNbrs(dataRows, headerIndex) {
            const seen = {};
            const result = [];
            dataRows.forEach((row) => {
                const v = (row[headerIndex.VENDOR_NBR] || '').trim();
                if (v && !seen[v]) {
                    seen[v] = true;
                    result.push(v);
                }
            });
            return result;
        }

        /**
         * Builds a flat OR-chain filter expression across multiple values on a
         * non-List/Record (free-text) field, e.g.:
         *   [[field,op,v1],'OR',[field,op,v2],'OR',[field,op,v3]]
         * 'anyof' can't be used here since custentity_ft_vendor_number is a text field.
         */
        function buildOrFilterChain(fieldId, values, operator) {
            const op = operator || 'is';
            const expr = [];
            values.forEach((v, i) => {
                if (i > 0) expr.push('OR');
                expr.push([fieldId, op, v]);
            });
            return expr;
        }

        /**
         * Resolves a list of VENDOR_NBR values to customer internal ids in a single
         * search (one search per file, not per row/group), caching results across
         * map() invocations. Returns a map of vendorNbr -> customerId (null if no
         * customer match was found for that vendor number).
         *
         * custentity_ft_vendor_number can hold MULTIPLE vendor numbers on one customer,
         * semicolon-separated (e.g. "737770193; 737770140; 737770030"), so an exact
         * 'is' match against a single vendor number will never hit. Instead this uses
         * 'contains' as a coarse pre-filter, then splits each result's field value on
         * ';' and only accepts an exact (trimmed) token match - so "193" can't
         * accidentally match inside "737770193".
         */
        function lookupCustomerIdsForVendorNbrs(vendorNbrs) {
            const uncached = vendorNbrs.filter(
                (v) => !Object.prototype.hasOwnProperty.call(vendorCustomerCache, v)
            );

            if (uncached.length > 0) {
                const uncachedSet = {};
                uncached.forEach((v) => { uncachedSet[v] = true; });

                const custSearch = search.create({
                    type: search.Type.CUSTOMER,
                    filters: [
                        buildOrFilterChain(CUSTOMER_VENDOR_NBR_FIELD, uncached, 'contains'),
                        'AND',
                        ['isinactive', 'is', 'F']
                    ],
                    columns: ['internalid', CUSTOMER_VENDOR_NBR_FIELD]
                });

                custSearch.run().each((result) => {
                    const rawFieldValue = result.getValue({ name: CUSTOMER_VENDOR_NBR_FIELD }) || '';
                    const tokens = rawFieldValue.split(';').map((t) => t.trim()).filter(Boolean);
                    tokens.forEach((token) => {
                        if (uncachedSet[token]) {
                            vendorCustomerCache[token] = result.id;
                        }
                    });
                    return true; // there could be more customers still to check
                });

                // Anything still unresolved genuinely has no customer match - cache that
                // as null so we don't re-search for it on a later file in this execution.
                uncached.forEach((v) => {
                    if (!Object.prototype.hasOwnProperty.call(vendorCustomerCache, v)) {
                        vendorCustomerCache[v] = null;
                    }
                });
            }

            const result = {};
            vendorNbrs.forEach((v) => { result[v] = vendorCustomerCache[v]; });
            return result;
        }

        /**
         * Normalizes a 2-digit year to the 2000s (e.g. 26 -> 2026). Needed because
         * MABD arrives as M/D/YY (e.g. "8/6/26"), and both new Date(year, ...) and
         * Date.UTC(year, ...) have a legacy JS quirk where a bare year 0-99 is
         * auto-mapped to 1900+year (so 26 silently becomes 1926) unless corrected
         * first. 4-digit years pass through unchanged.
         */
        function normalizeTwoDigitYear(year) {
            return year < 100 ? year + 2000 : year;
        }

        /**
         * Given an M/D/YYYY date string and a target day-of-week (JS convention:
         * 0=Sun ... 6=Sat), returns the date of that weekday for the same "week cycle"
         * as a Date object:
         * - already the target day -> same date
         * - offset 1-4 days after the target (in the mod-7 sense) -> the PRIOR
         *   occurrence of the target day
         * - offset 5-6 days after the target -> the NEXT occurrence of the target day
         *
         * This is the same asymmetric backward/forward split as the original
         * Friday-only logic (Sat/Sun/Mon/Tue -> prior Friday, Wed/Thu -> next Friday),
         * generalized to any target weekday: offset = (actualDow - targetDow + 7) % 7.
         * Returns null if the string can't be parsed.
         */
        function getAdjustedMabdDate(dateStr, targetDow) {
            if (!dateStr) return null;
            const parts = String(dateStr).trim().split('/');
            if (parts.length !== 3) return null;

            const month = parseInt(parts[0], 10);
            const day = parseInt(parts[1], 10);
            const year = normalizeTwoDigitYear(parseInt(parts[2], 10));
            if (!month || !day || !year) return null;

            const d = new Date(year, month - 1, day);
            const dow = d.getDay(); // 0=Sun ... 6=Sat

            if (dow === targetDow) return d; // already the target day

            const offset = (dow - targetDow + 7) % 7; // 1..6

            if (offset >= 1 && offset <= 4) {
                // Prior occurrence of the target day
                d.setDate(d.getDate() - offset);
            } else {
                // Next occurrence of the target day (offset 5 or 6)
                d.setDate(d.getDate() + (7 - offset));
            }
            return d;
        }

        /**
         * Converts a sail record's custrecord_ft_wmsail_mabd value (1=Sun...7=Sat, e.g.
         * 5=Thursday, 6=Friday, 7=Saturday) into the JS Date.getDay() convention
         * (0=Sun...6=Sat). Returns null if the value is missing/out of range.
         */
        function sailMabdValueToJsDow(sailMabdValue) {
            const n = parseInt(sailMabdValue, 10);
            if (!n || n < 1 || n > 7) return null;
            return n - 1;
        }

        /**
         * Converts an M/D/YYYY (or MM/DD/YY) string into an Excel-style date serial
         * number, matching the convention seen elsewhere in this account (e.g. 7/10/2026
         * -> 46213). Returns '' if the string can't be parsed.
         */
        function excelSerialFromDateString(dateStr) {
            if (!dateStr) return '';
            const parts = String(dateStr).trim().split('/');
            if (parts.length !== 3) return '';

            const month = parseInt(parts[0], 10);
            const day = parseInt(parts[1], 10);
            const year = normalizeTwoDigitYear(parseInt(parts[2], 10));
            if (!month || !day || !year) return '';

            const dateUtc = Date.UTC(year, month - 1, day);
            const excelEpochUtc = Date.UTC(1899, 11, 30); // Dec 30, 1899 - bakes in Excel's 1900 leap-year bug
            return Math.round((dateUtc - excelEpochUtc) / 86400000);
        }

        /**
         * Looks up customrecord_ft_walmart_saildates_dcloc by DC internal id + Pool internal id
         * (both already resolved from lookupLocationMasterId/lookupPoolMappingId). Returns
         * { id, fusionWarehouse, mabdDow } or null if no match. mabdDow is the JS
         * Date.getDay() convention (0=Sun...6=Sat) equivalent of the record's
         * custrecord_ft_wmsail_mabd value, or null if that field is missing/out of range.
         */
        function lookupSailRecordId(locationMasterId, poolMappingId) {
            const cacheKey = `${locationMasterId}|${poolMappingId}`;
            if (Object.prototype.hasOwnProperty.call(sailLookupCache, cacheKey)) {
                return sailLookupCache[cacheKey];
            }

            let found = null;
            const sailSearch = search.create({
                type: SAIL_RECORD_TYPE,
                filters: [
                    [SAIL_RECORD_DC_FIELD, 'anyof', locationMasterId],
                    'AND',
                    [SAIL_RECORD_POOL_FIELD, 'anyof', poolMappingId],
                    'AND',
                    ['isinactive', 'is', 'F']
                ],
                columns: ['internalid', SAIL_RECORD_FUSION_WAREHOUSE_FIELD, SAIL_RECORD_MABD_DOW_FIELD]
            });
            sailSearch.run().each((result) => {
                found = {
                    id: result.id,
                    fusionWarehouse: result.getValue({ name: SAIL_RECORD_FUSION_WAREHOUSE_FIELD }),
                    mabdDow: sailMabdValueToJsDow(result.getValue({ name: SAIL_RECORD_MABD_DOW_FIELD }))
                };
                return false; // first match only
            });

            sailLookupCache[cacheKey] = found;
            return found;
        }

        /** Looks up customrecord_ft_walmart_grs_mapping internal ID by custrecord_ft_wmgrsmap_pool, with caching. */
        function lookupPoolMappingId(poolNumber) {
            if (Object.prototype.hasOwnProperty.call(poolLookupCache, poolNumber)) {
                return poolLookupCache[poolNumber];
            }

            let foundId = null;
            const poolSearch = search.create({
                type: POOL_MAPPING_RECORD_TYPE,
                filters: [
                    [POOL_MAPPING_POOL_FIELD, 'is', poolNumber],
                    'AND',
                    ['isinactive', 'is', 'F']
                ],
                columns: ['internalid']
            });
            poolSearch.run().each((result) => {
                foundId = result.id;
                return false; // first match only
            });

            poolLookupCache[poolNumber] = foundId;
            return foundId;
        }

        /** Looks up customrecord_ft_location_master internal ID by custrecord_ft_wmdc_number, with caching. */
        function lookupLocationMasterId(dcNumber) {
            if (Object.prototype.hasOwnProperty.call(dcLookupCache, dcNumber)) {
                return dcLookupCache[dcNumber];
            }

            let foundId = null;
            const locSearch = search.create({
                type: LOCATION_MASTER_RECORD_TYPE,
                filters: [
                    [LOCATION_MASTER_DC_NBR_FIELD, 'is', dcNumber],
                    'AND',
                    ['isinactive', 'is', 'F']
                ],
                columns: ['internalid']
            });
            locSearch.run().each((result) => {
                foundId = result.id;
                return false; // first match only
            });

            dcLookupCache[dcNumber] = foundId;
            return foundId;
        }

        /**
         * Creates the customrecord_ft_walmart_grs record for a group - either an
         * "Initial Request" (per-customer, isConsolidated=false) or a "Consolidated
         * Request" (per POOL_DC_MABD rollup, isConsolidated=true). Skips (returns
         * existing id) if a record with the same externalid already exists, so re-runs
         * against an already-processed file don't create duplicates.
         *
         * recordTypeValue is written to custrecord_appointment_record_type (1 = Initial
         * Request, 2 = Consolidated Request). When isConsolidated is true,
         * custrecord_ft_vendor / custrecord_ft_vendor_number are left blank (a rollup
         * can span multiple customers/vendor numbers) and the externalid is built
         * without a customer segment so it can never collide with an initial record's
         * externalid for the same POOL/DC/MABD.
         */
        function createGrsRecord(group, recordTypeValue, isConsolidated) {
            const mabdSerial = excelSerialFromDateString(group.mabd);

            // Initial: POOL_DC_<customerOrVendorNbrs>_<mabdSerial>
            // Consolidated: POOL_DC_CONSOLIDATED_<mabdSerial>
            const externalId = isConsolidated
                ? `${group.pool}_${group.dc}_CONSOLIDATED_${mabdSerial}`
                : `${group.pool}_${group.dc}_${group.customerId || group.vendorNbrs.join('-')}_${mabdSerial}`;

            // POOL_DC_MABDserial - same MABD serial used in externalid, but without the
            // customer segment (e.g. 9846_6092_9715). Deliberately the same value for
            // an initial record and its corresponding consolidated record, since they
            // represent the same underlying appointment request.
            const quednsReqId = `${group.pool}_${group.dc}_${mabdSerial}`;

            const existing = findExistingByExternalId(externalId);
            if (existing) {
                log.audit('createGrsRecord - skipped (already exists)', `externalid ${externalId} -> record ${existing}`);
                return existing;
            }

            const locationMasterId = lookupLocationMasterId(group.dc);
            if (!locationMasterId) {
                log.audit(`createGrsRecord - no ${LOCATION_MASTER_RECORD_TYPE} for DC ${group.dc}`, `externalid ${externalId} - custrecord_ft_dc left blank`);
            }

            const poolMappingId = lookupPoolMappingId(group.pool);
            if (!poolMappingId) {
                log.audit(`createGrsRecord - no ${POOL_MAPPING_RECORD_TYPE} for POOL ${group.pool}`, `externalid ${externalId} - custrecord_ft_pool left blank`);
            }

            let sailRecord = null;
            if (locationMasterId && poolMappingId) {
                sailRecord = lookupSailRecordId(locationMasterId, poolMappingId);
            }
            if (!sailRecord) {
                log.audit(`createGrsRecord - no ${SAIL_RECORD_TYPE} match`,
                    `externalid ${externalId} - custrecord_sail_record / custrecord_ft_grs_location left blank`);
            }

            const rec = record.create({ type: CUSTOM_RECORD_TYPE, isDynamic: false });

            rec.setValue({ fieldId: 'externalid', value: externalId });
            rec.setValue({ fieldId: 'name', value: externalId });
            rec.setValue({ fieldId: APPOINTMENT_RECORD_TYPE_FIELD, value: recordTypeValue });
            rec.setValue({ fieldId: 'custrecord_ft_quedns_reqid', value: quednsReqId });
            if (poolMappingId) rec.setValue({ fieldId: 'custrecord_ft_pool', value: poolMappingId });
            if (locationMasterId) rec.setValue({ fieldId: 'custrecord_ft_dc', value: locationMasterId });
            if (sailRecord) {
                rec.setValue({ fieldId: 'custrecord_sail_record', value: sailRecord.id });
                if (sailRecord.fusionWarehouse) {
                    rec.setValue({ fieldId: 'custrecord_ft_grs_location', value: sailRecord.fusionWarehouse });
                }
            }
            if (!isConsolidated) {
                if (group.customerId) rec.setValue({ fieldId: 'custrecord_ft_vendor', value: group.customerId });
                // Raw VENDOR_NBR value(s) from the CSV (5th required column). Comma-separated
                // since multiple vendor numbers can resolve to the same customer and are
                // folded into this one group/record (e.g. 737770193,737770140,737770030).
                if (group.vendorNbrs.length > 0) {
                    rec.setValue({ fieldId: 'custrecord_ft_vendor_number', value: group.vendorNbrs.join(',') });
                }
            }
            // TRUCK (3rd required column) - comma-separated in the rare case a group spans
            // more than one truck number, same pattern as the PO list below.
            if (group.truckNumbers.length > 0) {
                rec.setValue({ fieldId: 'custrecord_ft_truck', value: group.truckNumbers.join(',') });
            }
            rec.setValue({ fieldId: 'custrecord_po_numbers', value: group.poNumbers.join(',') });
            rec.setValue({ fieldId: 'custrecord_ft_order_quantity', value: group.orderQty });
            rec.setValue({ fieldId: 'custrecord_ft_weight_quantity', value: group.weightQty });
            rec.setValue({ fieldId: 'custrecord_ft_cube_quantity', value: group.cubeQty });

            if (group.mabd) {
                try {
                    const mabdDate = format.parse({ value: group.mabd, type: format.Type.DATE });
                    rec.setValue({ fieldId: 'custrecord_ft_mabd', value: mabdDate });
                } catch (e) {
                    log.error('createGrsRecord - MABD date parse failed', `value: ${group.mabd} - ${e.message}`);
                }

                // Target weekday for the adjustment comes from the matched sail record's
                // custrecord_ft_wmsail_mabd (5=Thu, 6=Fri, 7=Sat, etc). Falls back to
                // Friday (JS dow 5) if there's no sail match or the field is blank/invalid.
                const targetDow = (sailRecord && sailRecord.mabdDow !== null && sailRecord.mabdDow !== undefined)
                    ? sailRecord.mabdDow
                    : 5;

                const adjMabd = getAdjustedMabdDate(group.mabd, targetDow);
                if (adjMabd) {
                    rec.setValue({ fieldId: 'custrecord_ft_adj_mabd', value: adjMabd });
                } else {
                    log.error('createGrsRecord - adjusted MABD calc failed', `value: ${group.mabd}`);
                }
            }

            // NOTE: the following fields exist on the custom record but have no source
            // column in this CSV - wire these up if/when a source is identified:
            //   custrecord_ft_walmart_grs_mapping, custrecord_ft_twovsthree_week_category,
            //   custrecord_appointment_datetime, custrecord_ft_grs_confirmed

            return rec.save();
        }

        function findExistingByExternalId(externalId) {
            let foundId = null;
            const recSearch = search.create({
                type: CUSTOM_RECORD_TYPE,
                filters: [['externalid', 'is', externalId]],
                columns: ['internalid']
            });
            recSearch.run().each((result) => {
                foundId = result.id;
                return false;
            });
            return foundId;
        }

        /** Writes the failed groups' original rows out to a CSV in the Error folder. */
        function writeErrorCsv(originalFile, errorEntries) {
            const headerRow = errorEntries[0].headerRow;
            const csvLines = [];
            csvLines.push([...headerRow, 'ERROR_REASON'].map(csvEscape).join(','));

            errorEntries.forEach((entry) => {
                entry.rows.forEach((row) => {
                    csvLines.push([...row, entry.error].map(csvEscape).join(','));
                });
            });

            const baseName = originalFile.name.replace(/\.csv$/i, '');
            const timestamp = new Date().getTime();
            const errorFileName = `ERROR_${baseName}_${timestamp}.csv`;

            const errFile = file.create({
                name: errorFileName,
                fileType: file.Type.CSV,
                contents: csvLines.join('\n'),
                folder: ERROR_FOLDER_ID
            });
            errFile.save();

            log.error(`writeErrorCsv - ${errorEntries.length} failed group(s) written`, errorFileName);
        }

        function csvEscape(value) {
            const str = String(value == null ? '' : value);
            if (str.indexOf(',') !== -1 || str.indexOf('"') !== -1 || str.indexOf('\n') !== -1) {
                return `"${str.replace(/"/g, '""')}"`;
            }
            return str;
        }

        function moveFile(fileObj, destFolderId) {
            fileObj.folder = destFolderId;
            fileObj.save();
        }

        return { getInputData, map, reduce, summarize };
    });