/**
* @NApiVersion 2.1
* @NScriptType MapReduceScript
* @NModuleScope SameAccount
*/
define(['N/file', 'N/search', 'N/record', 'N/runtime', 'N/log'], function (file, search, record, runtime, log) {

    // Configuration / Script Parameter defaults
    const CONFIG = {
        FILE_ID_PARAM: 'custscript_sample_loader_order_file_id', // Direct File ID parameter
        CUSTOMER_ID: 972653,                                 // Hardcoded Customer ID
        LOCATION_ID: 32                                      // Hardcoded Location ID (CA2)
    };

    // Helper: Parse CSV Line handling quotes and commas
    function parseCsvLine(line) {
        const out = [];
        let cur = '', inQuotes = false;
        for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            if (inQuotes) {
                if (ch === '"') {
                    if (i + 1 < line.length && line[i + 1] === '"') { cur += '"'; i++; }
                    else inQuotes = false;
                } else cur += ch;
            } else {
                if (ch === ',') { out.push(cur); cur = ''; }
                else if (ch === '"') inQuotes = true;
                else cur += ch;
            }
        }
        out.push(cur);
        return out;
    }

    // Helper: Parse date from YYYY-MM-DD or MM/DD/YYYY formats
    function parseDateString(dateStr) {
        if (!dateStr) return null;

        let delimiter = '';
        if (dateStr.indexOf('/') !== -1) {
            delimiter = '/';
        } else if (dateStr.indexOf('-') !== -1) {
            delimiter = '-';
        }

        if (delimiter) {
            const parts = dateStr.split(delimiter);
            if (parts.length === 3) {
                let year, month, day;
                // If the first part is 4 digits, it's YYYY-MM-DD or YYYY/MM/DD
                if (parts[0].trim().length === 4) {
                    year = parseInt(parts[0], 10);
                    month = parseInt(parts[1], 10) - 1; // 0-based
                    day = parseInt(parts[2], 10);
                } else {
                    // Otherwise assume MM/DD/YYYY or MM-DD-YYYY
                    month = parseInt(parts[0], 10) - 1; // 0-based
                    day = parseInt(parts[1], 10);
                    year = parseInt(parts[2], 10);
                }
                // Fix 2-digit years (e.g. 26 -> 2026, 07 -> 2007)
                if (year < 100) {
                    year += 2000;
                }

                const resultDate = new Date(year, month, day, 12, 0, 0);
                log.debug('parseDateString debug', {
                    input: dateStr,
                    parts: parts,
                    parsed: { year: year, month: month, day: day },
                    result: resultDate ? resultDate.toString() : 'null'
                });
                return resultDate;
            }
        }
        return null;
    }

    // Helper: Map Terms to custom field ID (Prepaid = 2, Collect = 1, Third Party = 3)
    function getTermsId(termsText) {
        if (!termsText) return null;
        const term = termsText.trim().toUpperCase();
        if (term === 'PREPAID') return 2;
        if (term === 'COLLECT') return 1;
        if (term === 'THIRD PARTY' || term === 'THIRDPARTY') return 3;
        return null;
    }

    // Helper: Map Order Type to custbody_ft_inboundoutbound (O = 2, R/I = 1)
    function getInboundOutboundId(typeText) {
        if (!typeText) return null;
        const typeVal = typeText.trim().toUpperCase();
        if (typeVal === 'O') return 2;
        if (typeVal === 'R' || typeVal === 'I') return 1;
        return null;
    }


    // Helper: Search Item Master Alias first, then fallback to WH Master Item List
    function findWHMasterRecord(itemCode, customerId) {
        if (!itemCode || !customerId) return null;
        const cleanItemCode = String(itemCode).trim();

        /*
        * STEP 1:
        * First search from Item Master Alias
        */
        try {
            const aliasSearch = search.create({
                type: 'customrecord_ft_item_master_alias',
                filters: [
                    ['name', 'is', cleanItemCode],
                    'AND',
                    ['custrecord_ft_alias_item.custrecord_ft_item_mas_customer', 'anyof', String(customerId)]
                ],
                columns: [
                    search.createColumn({ name: 'name', label: 'Name' }),
                    search.createColumn({ name: 'custrecord_ft_alias_item', label: 'Item' })
                ]
            });

            const aliasResults = aliasSearch.run().getRange({
                start: 0,
                end: 1
            });

            if (aliasResults && aliasResults.length > 0) {
                const aliasName = aliasResults[0].getValue({
                    name: 'name'
                });

                const itemMasterId = aliasResults[0].getValue({
                    name: 'custrecord_ft_alias_item'
                });

                const itemMasterText = aliasResults[0].getText({
                    name: 'custrecord_ft_alias_item'
                });

                if (itemMasterId) {
                    log.audit('Item Found From Alias', {
                        itemCode: cleanItemCode,
                        customerId: customerId,
                        aliasName: aliasName,
                        itemMasterId: itemMasterId,
                        itemMasterText: itemMasterText
                    });

                    return {
                        id: itemMasterId,
                        name: itemMasterText || aliasName || cleanItemCode
                    };
                }

                log.error('Alias Found But Linked Item Missing', {
                    itemCode: cleanItemCode,
                    customerId: customerId,
                    aliasName: aliasName
                });
            }

        } catch (e) {
            log.error('Error searching Item Master Alias', {
                itemCode: cleanItemCode,
                customerId: customerId,
                error: e
            });
        }

        /*
        * STEP 2:
        * If Item Master Alias not found, use old WH Master Item List logic
        */

        try {
            const whSearch = search.create({
                type: 'customrecord_wh_master_item_list',
                filters: [
                    ['custrecord_ft_item_mas_customer.internalidnumber', 'equalto', String(customerId)],
                    'AND',
                    [["name", "is", cleanItemCode], "OR", ["custrecord_ft_item_mast_upc", "is", cleanItemCode], "OR", ["custrecord_ft_item_mast_gtin", "is", cleanItemCode], "OR", ["custrecord_ft_item_mast_retailer_item", "is", cleanItemCode], "OR", ["custrecord_ft_item_mast_consig_item_code", "is", cleanItemCode], "OR", ["custrecord_ft_item_mast_externalsys_id", "is", cleanItemCode]]
                ],
                columns: [
                    search.createColumn({ name: 'name' })
                ]
            });

            const whResults = whSearch.run().getRange({
                start: 0,
                end: 1
            });

            if (whResults && whResults.length > 0) {
                const whItemCode = whResults[0].getValue({
                    name: 'name'
                });

                log.audit('Item Found From WH Master Item List', {
                    itemCode: cleanItemCode,
                    customerId: customerId,
                    whMasterId: whResults[0].id,
                    whItemCode: whItemCode
                });

                return {
                    id: whResults[0].id,
                    name: whItemCode
                };
            }

            log.error('Item Not Found In Alias Or WH Master Item List', {
                itemCode: cleanItemCode,
                customerId: customerId
            });

        } catch (e) {
            log.error('Error searching WH Master Item List fallback', {
                itemId: cleanItemCode,
                customerId: customerId,
                error: e
            });
        }

        return null;
    }

    // Helper: Search NetSuite location by custrecord_ft_location_key custom field
    function findLocationByKey(key) {
        if (!key) return null;
        try {
            const locSearch = search.create({
                type: search.Type.LOCATION,
                filters: [
                    ['custrecord_ft_location_key', 'is', key.trim()]
                ],
                columns: ['internalid']
            });
            const results = locSearch.run().getRange({ start: 0, end: 1 });
            if (results && results.length > 0) {
                return results[0].id;
            }
        } catch (e) {
            log.error(`Error searching location for key: ${key}`, e);
        }
        return null;
    }

    /**
     * Helper: Search a NetSuite custom list to find the internal ID of an option by name
     * @param {string} listId - The custom list ID (e.g. 'customlist_nmfc_codes')
     * @param {string} nameValue - The name text of the list option
     * @returns {number|null} The internal ID of the matching option, or null
     */
    function findCustomListIdByName(listId, nameValue) {
        if (!listId || !nameValue) return null;
        const targetText = String(nameValue).trim();
        if (!targetText) return null;
        try {
            const listSearch = search.create({
                type: listId,
                filters: [
                    ['name', 'is', targetText]
                ],
                columns: ['internalid']
            });
            const results = listSearch.run().getRange({ start: 0, end: 1 });
            if (results && results.length > 0) {
                return Number(results[0].id);
            }
        } catch (e) {
            log.error(`Error searching custom list ${listId} for name: ${targetText}`, e);
        }
        return null;
    }

    // Helper: Check if Sales Order already exists by externalid
    function salesOrderExists(externalId) {
        if (!externalId) return false;
        const soSearch = search.create({
            type: search.Type.SALES_ORDER,
            filters: [
                ['externalid', 'anyof', externalId],
                'AND',
                ['mainline', 'is', 'T']
            ],
            columns: ['internalid']
        });
        const results = soSearch.run().getRange({ start: 0, end: 1 });
        return (results && results.length > 0);
    }

    // Helper: Get customer default billing address or first address, along with email and fax
    function getCustomerBillingAddress(customerId) {
        if (!customerId) return null;
        const addressData = {
            attention: '',
            addresslabel: '',
            addressee: '',
            address1: '',
            address2: '',
            city: '',
            state: '',
            statedisplayname: '',
            zipcode: '',
            country: '',
            countrycode: '',
            addressphone: '',
            email: '',
            fax: ''
        };

        try {
            const customerFields = search.lookupFields({
                type: 'customer',
                id: customerId,
                columns: ['email', 'fax']
            });
            if (customerFields) {
                addressData.email = customerFields.email || '';
                addressData.fax = customerFields.fax || '';
            }
        } catch (e) {
            log.error('Error looking up customer email/fax', e);
        }

        try {
            const customerSearchObj = search.create({
                type: 'customer',
                filters: [
                    ['internalid', 'anyof', String(customerId)]
                ],
                columns: [
                    search.createColumn({
                        name: 'address',
                        join: 'Address',
                        label: 'Address'
                    }),
                    search.createColumn({
                        name: 'address1',
                        join: 'Address',
                        label: 'Address 1'
                    }),
                    search.createColumn({
                        name: 'address2',
                        join: 'Address',
                        label: 'Address 2'
                    }),
                    search.createColumn({
                        name: 'address3',
                        join: 'Address',
                        label: 'Address 3'
                    }),
                    search.createColumn({
                        name: 'addresslabel',
                        join: 'Address',
                        label: 'Address Label'
                    }),
                    search.createColumn({
                        name: 'addressphone',
                        join: 'Address',
                        label: 'Address Phone'
                    }),
                    search.createColumn({
                        name: 'addressee',
                        join: 'Address',
                        label: 'Addressee'
                    }),
                    search.createColumn({
                        name: 'attention',
                        join: 'Address',
                        label: 'Attention'
                    }),
                    search.createColumn({
                        name: 'city',
                        join: 'Address',
                        label: 'City'
                    }),
                    search.createColumn({
                        name: 'country',
                        join: 'Address',
                        label: 'Country'
                    }),
                    search.createColumn({
                        name: 'countrycode',
                        join: 'Address',
                        label: 'Country Code'
                    }),
                    search.createColumn({
                        name: 'isdefaultbilling',
                        join: 'Address',
                        label: 'Default Billing Address'
                    }),
                    search.createColumn({
                        name: 'isdefaultshipping',
                        join: 'Address',
                        label: 'Default Shipping Address'
                    }),
                    search.createColumn({
                        name: 'state',
                        join: 'Address',
                        label: 'State/Province'
                    }),
                    search.createColumn({
                        name: 'statedisplayname',
                        join: 'Address',
                        label: 'State/Province Display Name'
                    }),
                    search.createColumn({
                        name: 'zipcode',
                        join: 'Address',
                        label: 'Zip Code'
                    })
                ]
            });

            const results = customerSearchObj.run().getRange({ start: 0, end: 1000 });
            if (results && results.length > 0) {
                let billingRow = null;
                for (let i = 0; i < results.length; i++) {
                    const isDefaultBilling = results[i].getValue({
                        name: 'isdefaultbilling',
                        join: 'Address'
                    });
                    if (isDefaultBilling === true || isDefaultBilling === 'T') {
                        billingRow = results[i];
                        break;
                    }
                }

                if (!billingRow) {
                    billingRow = results[0];
                }

                addressData.attention = billingRow.getValue({ name: 'attention', join: 'Address' }) || '';
                addressData.addresslabel = billingRow.getValue({ name: 'addresslabel', join: 'Address' }) || '';
                addressData.addressee = billingRow.getValue({ name: 'addressee', join: 'Address' }) || '';
                addressData.address1 = billingRow.getValue({ name: 'address1', join: 'Address' }) || '';
                addressData.address2 = billingRow.getValue({ name: 'address2', join: 'Address' }) || '';
                addressData.city = billingRow.getValue({ name: 'city', join: 'Address' }) || '';
                addressData.state = billingRow.getValue({ name: 'state', join: 'Address' }) || '';
                addressData.statedisplayname = billingRow.getValue({ name: 'statedisplayname', join: 'Address' }) || '';
                addressData.zipcode = billingRow.getValue({ name: 'zipcode', join: 'Address' }) || '';
                addressData.country = billingRow.getValue({ name: 'country', join: 'Address' }) || '';
                addressData.countrycode = billingRow.getValue({ name: 'countrycode', join: 'Address' }) || '';
                addressData.addressphone = billingRow.getValue({ name: 'addressphone', join: 'Address' }) || '';
            }
        } catch (e) {
            log.error('Error fetching customer billing address search details', e);
        }

        return addressData;
    }

    // ================== ENTRY POINTS ==================

    /**
    * Retrieves the file ID directly from script parameter
    */
    function getInputData() {
        try {
            const script = runtime.getCurrentScript();
            const fileId = script.getParameter({ name: CONFIG.FILE_ID_PARAM });

            if (!fileId) {
                log.error('Missing Parameter', `Script parameter ${CONFIG.FILE_ID_PARAM} is not configured.`);
                return [];
            }

            log.audit('getInputData', `Processing single file ID: ${fileId}`);

            return [{
                id: fileId,
                name: 'Direct_File_Import_' + fileId + '.csv'
            }];
        } catch (e) {
            log.error('Error in getInputData', e.message || e.toString());
            return [];
        }
    }

    /**
    * Map stage: Loads each file, parses rows, and writes grouped by SID
    */
    function map(context) {
        let fileId;
        let fileName;
        try {
            const fileMeta = JSON.parse(context.value);
            fileId = fileMeta.id;
            fileName = fileMeta.name;

            log.audit('map stage', `Processing file: ${fileName} (ID: ${fileId})`);

            const f = file.load({ id: fileId });
            const iterator = f.lines.iterator();

            let header = null;
            let lineIndex = 0;
            let emittedCount = 0;

            iterator.each(function (lineObj) {
                lineIndex++;
                let lineText = lineObj.value;

                // Strip BOM if present on the first line
                if (lineIndex === 1 && lineText && lineText.charCodeAt(0) === 0xFEFF) {
                    lineText = lineText.substring(1);
                }

                if (!lineText || lineText.trim() === '') {
                    return true;
                }

                // Parse the line columns
                const columns = parseCsvLine(lineText);

                // Row 1: Header Definitions
                if (lineIndex === 1) {
                    header = columns.map(c => c.trim());
                    return true;
                }

                // Build Row Object
                const row = {};
                for (let c = 0; c < header.length; c++) {
                    row[header[c]] = (c < columns.length ? columns[c].trim() : '');
                }

                // SID is the unique identifier for order grouping
                const sid = row['SID - unique identifier for the ORDER/SN'] || row['SID'];
                if (!sid || sid.trim() === '' || isNaN(Number(sid.trim()))) {
                    log.debug('Skip Row', `Line ${lineIndex} skipped (empty or invalid/non-numeric SID: "${sid}")`);
                    return true;
                }

                context.write({
                    key: sid.trim(),
                    value: JSON.stringify(row)
                });
                emittedCount++;
                return true;
            });

            log.audit('File processing complete', `Processed ${lineIndex} lines in ${fileName}. Emitted ${emittedCount} rows.`);

        } catch (e) {
            log.error(`Error in map stage for file ID ${fileId}`, e.message || e.toString());
        }
    }

    /**
    * Reduce stage: Groups rows by SID and creates standard Sales Orders
    */
    function reduce(context) {
        const sid = context.key;
        const rows = context.values.map(v => JSON.parse(v));

        log.audit('reduce stage', `Creating Sales Order for SID: ${sid} (Rows to process: ${rows.length})`);

        const script = runtime.getCurrentScript();
        const soMappingStr = script.getParameter({ name: 'custscript_sales_order_mapping' });
        const itemMappingStr = script.getParameter({ name: 'custscript_inventory_item_mapping' });
        const dropdownMappingStr = script.getParameter({ name: 'custscript_dropdown_list_mappings' });

        let soMapping = null;
        if (soMappingStr) {
            try {
                soMapping = JSON.parse(soMappingStr);
            } catch (e) {
                log.error('Error parsing sales order mapping JSON', e);
            }
        }

        let itemMapping = null;
        if (itemMappingStr) {
            try {
                itemMapping = JSON.parse(itemMappingStr);
            } catch (e) {
                log.error('Error parsing inventory item mapping JSON', e);
            }
        }

        let dropdownMappings = {
            'custrecord_ft_invitem_freightclass': 'customlist_nmfc_codes',
            'custrecord_ft_invitem_contract_type': 'customlist_inventory_item_contract_typ',
            'custrecord_ft_invitem_uom': 'customlist1488'
        };
        if (dropdownMappingStr) {
            try {
                const parsedDropdowns = JSON.parse(dropdownMappingStr);
                for (const key in parsedDropdowns) {
                    dropdownMappings[key] = parsedDropdowns[key];
                }
            } catch (e) {
                log.error('Error parsing dropdown list mappings JSON', e);
            }
        }

        try {
            // Check if Sales Order already exists
            if (salesOrderExists(sid)) {
                log.audit('Sales Order Skip', `Sales Order with externalid/SID "${sid}" already exists. Skipping creation.`);
                return;
            }

            // Extract order-level properties from the first row
            const firstRow = rows[0];
            const customerId = firstRow['Company ID'] || CONFIG.CUSTOMER_ID;

            // 1. Group and aggregate fields across all rows under this SID
            const poNumbers = [];
            let totalCases = 0;
            let totalWeight = 0;
            let totalPallets = 0;

            const itemQuantities = {};
            const itemDescriptions = {};
            const itemRows = {};

            rows.forEach(row => {
                // Aggregate distinct POs
                const po = (row['PO'] || '').trim();
                if (po && poNumbers.indexOf(po) === -1) {
                    poNumbers.push(po);
                }

                // Sum metrics
                totalCases += parseFloat(row['ORDER QTY IN CTN']) || 0;
                totalWeight += parseFloat(row['Line Weight']) || 0;
                totalPallets += parseFloat(row['Pallet Count']) || 0;

                // Group quantities and descriptions by WMS Item Number
                const itemCode = (row['WMS_ITEM_NUMBER'] || '').trim();
                if (itemCode) {
                    itemQuantities[itemCode] = (itemQuantities[itemCode] || 0) + (parseFloat(row['ORDER QTY IN CTN']) || 0);
                    itemDescriptions[itemCode] = row['Item Desc'] || itemDescriptions[itemCode] || '';
                    if (!itemRows[itemCode]) {
                        itemRows[itemCode] = row;
                    }
                }
            });

            // 2. Initialize Sales Order Record in Dynamic Mode
            const soRec = record.create({
                type: record.Type.SALES_ORDER,
                isDynamic: true
            });

            soRec.setValue('customform', 161);

            // Maps Type: O -> 2 (Outbound), R/I -> 1 (Inbound)
            const inboundOutbound = getInboundOutboundId(firstRow['TYPE']);
            if (inboundOutbound) {
                soRec.setValue({ fieldId: 'custbody_ft_inboundoutbound', value: inboundOutbound });
            }

            // Set Warehouse Appointment Date based on inbound/outbound type
            const shipDateVal = parseDateString(firstRow['SHIPDATE']);
            const deliverDateVal = parseDateString(firstRow['DUEDATE - MABD'] || firstRow['DUEDATE']) || shipDateVal;
            // const deliverDateVal = '';

            if (inboundOutbound === 1) { // Inbound
                if (deliverDateVal) {
                    soRec.setValue({ fieldId: 'custbody_ft_wh_appt_date', value: deliverDateVal });
                    log.debug('Set Warehouse Appt Date (Inbound)', deliverDateVal);
                }
            } else { // Outbound
                if (shipDateVal) {
                    soRec.setValue({ fieldId: 'custbody_ft_wh_appt_date', value: shipDateVal });
                    log.debug('Set Warehouse Appt Date (Outbound)', shipDateVal);
                }
            }

            // Determine Location based on Outbound vs Inbound
            const typeVal = (firstRow['TYPE'] || '').trim().toUpperCase();
            let locationKey = '';
            if (typeVal === 'O') {
                locationKey = firstRow['SHIP FROM SHORT KEY'];
            } else if (typeVal === 'R' || typeVal === 'I') {
                locationKey = firstRow['SHIP TO SHORT KEY'];
            }

            let orderLocationId = CONFIG.LOCATION_ID;
            if (locationKey) {
                const foundLocId = findLocationByKey(locationKey);
                if (foundLocId) {
                    orderLocationId = foundLocId;
                    log.audit('Location Mapped', `Mapped location key "${locationKey}" to NetSuite Location ID: ${orderLocationId}`);
                } else {
                    log.audit('Location Fallback', `Location key "${locationKey}" not found in NetSuite. Using default: ${orderLocationId}`);
                }
            } else {
                log.debug('No Location Key', `No location key found for type: "${typeVal}". Using default: ${orderLocationId}`);
            }

            // Set main body fields
            soRec.setValue({ fieldId: 'entity', value: customerId });
            soRec.setValue({ fieldId: 'location', value: orderLocationId });
            soRec.setValue({ fieldId: 'externalid', value: sid });
            soRec.setValue({ fieldId: 'custbody_po_number_vb', value: poNumbers.join(', ') });

            // Custom aggregated body fields
            soRec.setValue({ fieldId: 'custbody_ft_totalcases', value: totalCases });
            soRec.setValue({ fieldId: 'custbody_ft_totalweight', value: totalWeight });
            soRec.setValue({ fieldId: 'custbody_ft_totalpallets', value: totalPallets });

            // Custom body mappings (SID is core identifier)
            soRec.setValue({ fieldId: 'custbody_ft_sid', value: sid });

            // Fetch and set customer billing address fields
            const billingAddress = getCustomerBillingAddress(customerId);
            if (billingAddress) {
                if (billingAddress.attention) soRec.setValue({ fieldId: 'custbody_ft_billattention', value: billingAddress.attention });
                if (billingAddress.addresslabel) soRec.setValue({ fieldId: 'custbody_ft_billloccode', value: billingAddress.addresslabel });
                if (billingAddress.addressee) soRec.setValue({ fieldId: 'custbody_ft_billaddressee', value: billingAddress.addressee });
                if (billingAddress.address1) soRec.setValue({ fieldId: 'custbody_ft_billaddress1', value: billingAddress.address1 });
                if (billingAddress.address2) soRec.setValue({ fieldId: 'custbody_ft_billaddress2', value: billingAddress.address2 });
                if (billingAddress.city) soRec.setValue({ fieldId: 'custbody_ft_billcity', value: billingAddress.city });
                if (billingAddress.state) soRec.setValue({ fieldId: 'custbody_ft_billstate', value: billingAddress.state });
                if (billingAddress.zipcode) soRec.setValue({ fieldId: 'custbody_ft_billzip', value: billingAddress.zipcode });
                if (billingAddress.countrycode) {
                    soRec.setValue({ fieldId: 'custbody_ft_billcountry', value: billingAddress.countrycode });
                } else if (billingAddress.country) {
                    soRec.setValue({ fieldId: 'custbody_ft_billcountry', value: billingAddress.country });
                }
                if (billingAddress.addressphone) soRec.setValue({ fieldId: 'custbody_ft_billphone', value: billingAddress.addressphone });
                if (billingAddress.email) soRec.setValue({ fieldId: 'custbody_ft_billemail', value: billingAddress.email });
                if (billingAddress.fax) soRec.setValue({ fieldId: 'custbody_ft_billfax', value: billingAddress.fax });
            }

            // 3. Apply field mappings (Dynamic via parameter OR Legacy Hardcoded Fallback)
            if (soMapping) {
                for (const csvHeader in soMapping) {
                    const nsFieldId = soMapping[csvHeader];
                    const csvValue = firstRow[csvHeader];
                    if (csvValue !== undefined && csvValue !== null && csvValue !== '') {
                        if (nsFieldId.indexOf('.') !== -1) {
                            const parts = nsFieldId.split('.');
                            const subrecId = parts[0];
                            const subfieldId = parts[1];
                            try {
                                const subrec = soRec.getSubrecord({ fieldId: subrecId });
                                if (subrec) {
                                    let subValue = csvValue;
                                    if (subfieldId === 'country') {
                                        const country = String(csvValue).trim().toUpperCase();
                                        if (country === 'USA') {
                                            subValue = 'US';
                                        } else {
                                            subValue = country;
                                        }
                                    }
                                    subrec.setValue({ fieldId: subfieldId, value: subValue });
                                }
                            } catch (subErr) {
                                log.error(`Error setting subrecord ${subrecId} field ${subfieldId}`, subErr);
                            }
                        } else {
                            if (nsFieldId === 'custbody_ft_planshipdate' || nsFieldId === 'custbody_ft_plandelivery' || nsFieldId === 'trandate' || nsFieldId === 'shipdate') {
                                const dateObj = parseDateString(csvValue);
                                if (dateObj) {
                                    soRec.setValue({ fieldId: nsFieldId, value: dateObj });
                                }
                            } else if (nsFieldId === 'custbody_ft_inboundoutbound') {
                                const inboundOutbound = getInboundOutboundId(csvValue);
                                if (inboundOutbound) {
                                    soRec.setValue({ fieldId: nsFieldId, value: inboundOutbound });
                                }
                            } else if (nsFieldId === 'custbody_ft_shipmethod') {
                                const termsId = getTermsId(csvValue);
                                if (termsId) {
                                    soRec.setValue({ fieldId: nsFieldId, value: termsId });
                                }
                            } else if (nsFieldId === 'location') {
                                const foundLocId = findLocationByText(csvValue);

                                if (foundLocId) {
                                    soRec.setValue({
                                        fieldId: 'location',
                                        value: Number(foundLocId)
                                    });

                                    log.audit('Header Location Set From CSV', {
                                        csvValue: csvValue,
                                        locationInternalId: foundLocId
                                    });
                                } else {
                                    log.error('Header Location Not Found', {
                                        csvValue: csvValue,
                                        message: 'No active NetSuite Location found by CSV text/name or internal ID.'
                                    });
                                }
                            } else {
                                const valStr = String(csvValue).trim().toLowerCase();
                                if (valStr === 't' || valStr === 'true') {
                                    soRec.setValue({ fieldId: nsFieldId, value: true });
                                } else if (valStr === 'f' || valStr === 'false') {
                                    soRec.setValue({ fieldId: nsFieldId, value: false });
                                } else {
                                    soRec.setValue({ fieldId: nsFieldId, value: csvValue });
                                }
                            }
                        }
                    }
                }
            } else {
                // Dates
                const shipDate = parseDateString(firstRow['SHIPDATE']);
                if (shipDate) {
                    soRec.setValue({ fieldId: 'custbody_ft_planshipdate', value: shipDate });
                }

                const dueDate = parseDateString(firstRow['DUEDATE - MABD'] || firstRow['DUEDATE']);
                if (dueDate) {
                    soRec.setValue({ fieldId: 'custbody_ft_plandelivery', value: dueDate });
                }

                // Terms mapping to custom field
                const termsId = getTermsId(firstRow['TERMS']);
                if (termsId) {
                    soRec.setValue({ fieldId: 'custbody_ft_shipmethod', value: termsId });
                }

                // Custom body mappings (Shipping Loc Code, and Ship From Address)
                if (firstRow['SHIP FROM SHORT KEY']) {
                    soRec.setValue({ fieldId: 'custbody_ft_shiploccode', value: firstRow['SHIP FROM SHORT KEY'] });
                }
                if (firstRow['SHIP FROM ADDRESS1']) {
                    soRec.setValue({ fieldId: 'custbody_ft_shipfromadd1', value: firstRow['SHIP FROM ADDRESS1'] });
                }
                if (firstRow['SHIP FROM CITY']) {
                    soRec.setValue({ fieldId: 'custbody_ft_shipfromcity', value: firstRow['SHIP FROM CITY'] });
                }
                if (firstRow['SHIP FROM STATE']) {
                    soRec.setValue({ fieldId: 'custbody_ft_shipfromstate', value: firstRow['SHIP FROM STATE'] });
                }
                if (firstRow['SHIP FROM ZIP CODE'] || firstRow['SHIP FROM ZIP']) {
                    soRec.setValue({ fieldId: 'custbody_ft_shipfromzip', value: firstRow['SHIP FROM ZIP CODE'] || firstRow['SHIP FROM ZIP'] });
                }
                if (firstRow['SHIP FROM CTRY']) {
                    soRec.setValue({ fieldId: 'custbody_ft_shipfromcountry', value: firstRow['SHIP FROM CTRY'] });
                }

            }

            // Legacy Shipping Address Subrecord (Always update standard Shipping Address if ship-to fields are present)
            const shipAddr = soRec.getSubrecord({ fieldId: 'shippingaddress' });
            if (shipAddr) {
                if (firstRow['SHIP TO NAME']) shipAddr.setValue({ fieldId: 'addressee', value: firstRow['SHIP TO NAME'] });
                if (firstRow['SHIP TO ADDRESS 1']) shipAddr.setValue({ fieldId: 'addr1', value: firstRow['SHIP TO ADDRESS 1'] });
                if (firstRow['SHIP TO CITY']) shipAddr.setValue({ fieldId: 'city', value: firstRow['SHIP TO CITY'] });
                if (firstRow['SHIP TO STATE']) shipAddr.setValue({ fieldId: 'state', value: firstRow['SHIP TO STATE'] });
                if (firstRow['SHIP TO ZIP CODE']) shipAddr.setValue({ fieldId: 'zip', value: firstRow['SHIP TO ZIP CODE'] });

                const country = (firstRow['SHIP TO CTRY'] || '').trim().toUpperCase();
                if (country === 'USA') {
                    shipAddr.setValue({ fieldId: 'country', value: 'US' });
                } else if (country) {
                    shipAddr.setValue({ fieldId: 'country', value: country });
                }
            }

            // 4. Add Sublist Items

            // Fixed Item 1: 8797
            soRec.selectNewLine({ sublistId: 'item' });
            soRec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'item', value: 8797 });
            soRec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'quantity', value: 1 });
            soRec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'rate', value: 0.01 });
            soRec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'amount', value: 0.01 });
            soRec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'custcol_source_system', value: 2 });
            soRec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'department', value: 10 });
            soRec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'location', value: orderLocationId });
            soRec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'description', value: 'Placeholder item for initial order creation' });
            soRec.commitLine({ sublistId: 'item' });

            // Fixed Item 2: 2990
            soRec.selectNewLine({ sublistId: 'item' });
            soRec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'item', value: 2990 });
            soRec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'quantity', value: 1 });
            soRec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'rate', value: 0.01 });
            soRec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'amount', value: 0.01 });
            soRec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'custcol_source_system', value: 3 });
            soRec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'department', value: 4 });
            soRec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'location', value: orderLocationId });
            soRec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'description', value: 'Place holder item for initial Synapse order creation' });
            soRec.commitLine({ sublistId: 'item' });

            // Re-apply header location right before saving to prevent Dynamic Mode sourcing from clearing it
            soRec.setValue({ fieldId: 'location', value: orderLocationId });

            // Save Sales Order first to get the internal ID (soId)
            const soId = soRec.save({
                enableSourcing: true,
                ignoreMandatoryFields: true
            });

            log.audit('Sales Order Created Successfully', `Created Sales Order ID: ${soId} for SID/externalid: ${sid}`);

            // Find WH Master record and create a new custom inventory item for each item code
            for (const itemCode in itemQuantities) {
                const whMasterRec = findWHMasterRecord(itemCode, customerId);
                if (!whMasterRec) {
                    log.error('Item Skip', `No WH Master Record found for Consignee Item: ${itemCode}. Skipped creating Custom Inventory Item.`);
                    continue;
                }

                try {
                    const invItemRec = record.create({
                        type: 'customrecord_ft_inventory_items',
                        isDynamic: true
                    });

                    invItemRec.setValue({ fieldId: 'name', value: whMasterRec.name });
                    invItemRec.setValue({ fieldId: 'custrecord_ft_invitem_customer', value: customerId });
                    invItemRec.setValue({ fieldId: 'custrecord_ft_invitem_mgorder', value: soId });
                    invItemRec.setValue({ fieldId: 'custrecord_ft_invitem_item', value: whMasterRec.id });

                    // Apply dynamic inventory item mapping if present
                    if (itemMapping && itemRows) {
                        const representativeRow = itemRows[itemCode];
                        if (representativeRow) {
                            for (const csvHeader in itemMapping) {
                                const nsFieldId = itemMapping[csvHeader];
                                let csvValue = representativeRow[csvHeader];
                                if (csvHeader === 'ORDER QTY IN CTN') {
                                    csvValue = itemQuantities[itemCode];
                                }
                                if (csvValue !== undefined && csvValue !== null && csvValue !== '') {
                                    const lowFieldId = nsFieldId.toLowerCase();
                                    if (lowFieldId.indexOf('date') !== -1 || lowFieldId.indexOf('dt') !== -1) {
                                        const dateObj = parseDateString(csvValue);
                                        if (dateObj) {
                                            invItemRec.setValue({ fieldId: nsFieldId, value: dateObj });
                                        } else {
                                            invItemRec.setValue({ fieldId: nsFieldId, value: csvValue });
                                        }
                                    } else {
                                        const valStr = String(csvValue).trim().toLowerCase();
                                        if (valStr === 't' || valStr === 'true') {
                                            invItemRec.setValue({ fieldId: nsFieldId, value: true });
                                        } else if (valStr === 'f' || valStr === 'false') {
                                            invItemRec.setValue({ fieldId: nsFieldId, value: false });
                                        } else {
                                            let finalValue = csvValue;
                                            if (dropdownMappings[nsFieldId]) {
                                                const listId = dropdownMappings[nsFieldId];
                                                const resolvedId = findCustomListIdByName(listId, csvValue);
                                                if (resolvedId) {
                                                    finalValue = resolvedId;
                                                } else if (csvValue && !isNaN(Number(csvValue))) {
                                                    finalValue = Number(csvValue);
                                                } else {
                                                    log.error('Dropdown Resolution Failed', `Could not find option "${csvValue}" in custom list "${listId}" for field "${nsFieldId}". Setting to null to avoid crash.`);
                                                    finalValue = null;
                                                }
                                            } else if (lowFieldId.indexOf('qty') !== -1 || lowFieldId.indexOf('weight') !== -1 || lowFieldId.indexOf('cube') !== -1 || lowFieldId.indexOf('pallet') !== -1 || lowFieldId.indexOf('count') !== -1 || lowFieldId.indexOf('seq') !== -1 || lowFieldId.indexOf('amount') !== -1) {
                                                const parsedNum = Number(csvValue);
                                                if (!isNaN(parsedNum)) {
                                                    finalValue = parsedNum;
                                                }
                                            }
                                            invItemRec.setValue({ fieldId: nsFieldId, value: finalValue });
                                        }
                                    }
                                }
                            }
                        }
                    }

                    const invItemRecId = invItemRec.save({
                        enableSourcing: true,
                        ignoreMandatoryFields: true
                    });
                    log.audit('Created Custom Inventory Item', `Created customrecord_ft_inventory_items ID: ${invItemRecId} for item: ${whMasterRec.name} linked to Sales Order ID: ${soId}`);
                } catch (createErr) {
                    log.error(`Error creating customrecord_ft_inventory_items for item: ${whMasterRec.name}`, createErr);
                }
            }

        } catch (err) {
            log.error(`Failed to process SID ${sid}`, err || err.toString());
        }
    }
    // Helper: Search NetSuite Location by header/list text and return internal ID
    function findLocationByText(locationText) {
        if (!locationText) return null;

        const searchText = String(locationText).trim();
        if (!searchText) return null;

        // If CSV already contains internal ID
        if (!isNaN(Number(searchText))) {
            return Number(searchText);
        }

        function normalize(value) {
            return String(value || '')
                .replace(/\s+/g, ' ')
                .trim()
                .toUpperCase();
        }

        const targetText = normalize(searchText);
        let foundId = null;

        try {
            const locSearch = search.create({
                type: search.Type.LOCATION,
                filters: [
                    ['isinactive', 'is', 'F']
                ],
                columns: [
                    search.createColumn({ name: 'internalid' }),
                    search.createColumn({ name: 'name' })
                ]
            });

            locSearch.run().each(function (result) {
                const locId = result.getValue({ name: 'internalid' });
                const locName = result.getValue({ name: 'name' });

                const fullName = normalize(locName);
                const nameWithoutHierarchy = normalize(String(locName || '').split(':').pop());

                if (fullName === targetText || nameWithoutHierarchy === targetText) {
                    foundId = locId;
                    return false;
                }

                return true;
            });

        } catch (e) {
            log.error('Error searching location by text', {
                locationText: searchText,
                error: e
            });
        }

        return foundId;
    }

    /**
    * Map/Reduce execution summary log
    */
    function summarize(summary) {
        log.audit('Summarize stage', 'Map/Reduce completed.');
        if (summary.inputSummary.error) {
            log.error('Input Error', summary.inputSummary.error);
        }
        summary.mapSummary.errors.iterator().each((key, error) => {
            log.error(`Map Error for key ${key}`, error);
            return true;
        });
        summary.reduceSummary.errors.iterator().each((key, error) => {
            log.error(`Reduce Error for key ${key}`, error);
            return true;
        });
    }

    return {
        getInputData: getInputData,
        map: map,
        reduce: reduce,
        summarize: summarize
    };
});
