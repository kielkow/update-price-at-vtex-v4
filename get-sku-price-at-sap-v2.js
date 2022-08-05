const parser = require('linkapi-sdk/parser');

module.exports = async (documentType, vtexTable, skuPayload, sold_to) => {
	const samsung_sap_rest = new linkapi.Component('samsung_sap_rest', {});

	//ESTA FALTANDO PREENCHER BILL-TO E SHIP-TO - PQ PRECISAMOS DESSES DADOS? DEVERIA SER SÓ SKU, PLANTA E LGORT

	let xml = `
				<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:sda="http://sec.com/GLS_ECC_SD/SDA">
				<soapenv:Header/>
				<soapenv:Body>
					<sda:MT_ZSDA_PRICE_SIMULATION>
						<!--Optional:-->
						<PI_ORDSIM>X</PI_ORDSIM>
						<!--Optional:-->
						<PI_KOMK>
							<!--Optional:-->
							<VKORG>8201</VKORG>
							<!--Optional:-->
							<VTWEG>${documentType}</VTWEG>
							<!--Optional:-->
							<SPART>00</SPART>
							<!--Optional:-->
							<KUNNR>${sold_to}</KUNNR>
							<!--Optional:-->
							<KNRZE></KNRZE>
							<!--Optional:-->
							<KUNRE></KUNRE>
							<!--Optional:-->
							<KUNWE></KUNWE>
							<!--Optional:-->
							<PRSDT>${linkapi.moment().format('YYYYMMDD')}</PRSDT>
							<!--Optional:-->
							<AUART>YS10</AUART>
							<!--Optional:-->
							<AUART_SD>YS10</AUART_SD>
						</PI_KOMK>
						<!--Zero or more repetitions:-->
						${skuPayload}
					</sda:MT_ZSDA_PRICE_SIMULATION>
				</soapenv:Body>
				</soapenv:Envelope>
			`;
	xml = xml.replace(new RegExp("\\n", "g"), "");
	xml = xml.replace(new RegExp("\\t", "g"), "");

	const priceResponse = await samsung_sap_rest.request('POST', 'IF_VTEX_NERP_SD00876', {
		body: {
			xml
		}
	});

	const priceResponseJson = await parser.xml.toJSON(priceResponse.body);
	const pteReturn = priceResponseJson["SOAP:Envelope"]["SOAP:Body"]["n0:MT_ZSDA_PRICE_SIMULATION_R"].PTE_RETURN['0'];

	if (pteReturn &&
		pteReturn.TYPE === 'E') {

		throw {
			request: xml,
			response: priceResponse.body
		};
	}

	const pteCond = priceResponseJson["SOAP:Envelope"]["SOAP:Body"]["n0:MT_ZSDA_PRICE_SIMULATION_R"].PTE_COND;
	const ptieKomp = priceResponseJson["SOAP:Envelope"]["SOAP:Body"]["n0:MT_ZSDA_PRICE_SIMULATION_R"].PTIE_KOMP;

	const skuArr = [];
	const skusFormated = [];

	Object.keys(ptieKomp).reduce((map, key) => {
		const sku = ptieKomp[key].MATNR ? ptieKomp[key].MATNR : ptieKomp['MATNR'];
		const increment = ptieKomp[key].KPOSN ? ptieKomp[key].KPOSN : ptieKomp['KPOSN'];

		skuArr.push({
			sku,
			increment
		});

		return map;
	}, {});

	Object.keys(pteCond).reduce((map, key) => {
		if (pteCond[key].KSCHL === '1000') {
			const { sku } = skuArr.find((skuAr) => skuAr.increment === pteCond[key].KPOSN);
			skusFormated.push({
				price: parseFloat((pteCond[key].KBETR)),
				sku,
				vtexTable,
				uniqueKey: `${sku}-${vtexTable}`
			});
		}


		return map;
	}, {});

	return skusFormated
};
