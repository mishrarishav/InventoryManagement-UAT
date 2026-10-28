// Please see documentation at https://docs.microsoft.com/aspnet/core/client-side/bundling-and-minification
// for details on configuring this project to bundle and minify static web assets.

// Write your JavaScript code.
function initDataTable(tableId, downloadfileName, options) {
    return $(tableId).DataTable(Object.assign({
        order: [],
        dom: downloadfileName ? 'Blfrtip' : 'lfrtip',
        buttons: downloadfileName ? [
            {
                extend: 'csv',
                text: 'Download',
                bom: true,
                filename: function () {
                    var today = new Date();
                    var dd = String(today.getDate()).padStart(2, '0');
                    var mm = String(today.getMonth() + 1).padStart(2, '0'); //January is 0!
                    var yyyy = today.getFullYear();
                    today = dd + '_' + mm + '_' + yyyy;
                    return downloadfileName + "_" + today;
                }
            }
        ] : [],
        "lengthMenu": [[10, 25, 50, -1], [10, 25, 50, "All"]],
        "paging": true,
        "lengthChange": false,
        "searching": true,
        "ordering": true,
        "filtering": true,
        "info": true,
        "autoWidth": true,
        "pageLength": 50,

    }, options || {}));
}

// Sort dates by full timestamps rather than localized display strings.
function renderReportDate(value, type) {
    if (!value) return type === 'sort' || type === 'type' ? 0 : '';
    var date = new Date(value);
    if (isNaN(date.getTime())) return value;
    return type === 'sort' || type === 'type' ? date.getTime() : date.toLocaleString('en-IN');
}

function reportDateOptions() {
    return { order: [[0, 'desc']], columnDefs: [{ targets: 0, render: renderReportDate }] };
}

function renderReportCurrency(value, type) {
    if (value == null) return type === 'display' || type === 'filter' ? '—' : '';
    return type === 'display' || type === 'filter'
        ? new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(value)
        : Number(value);
}
